use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

mod drawing;
pub use drawing::MAX_DRAWING_BYTES;
mod operations;
pub use operations::VaultEntry;
mod history;
pub use history::{HistoryEntry, HistorySnapshot, MAX_SNAPSHOT_BYTES};
mod activity;
pub use activity::NoteActivityDay;
mod storage;
pub use storage::StorageDiagnostics;
mod pdf;
pub use pdf::{PdfAnnotationUpdate, PdfAnnotations, PdfDocument};
mod vault_export;
pub mod webdav;

#[derive(Debug)]
pub enum VaultError {
    InvalidPath,
    UnsupportedFile,
    UnsupportedMove,
    InvalidUtf8,
    TooLarge,
    InvalidCanvas,
    InvalidDrawing,
    DrawingTooLarge,
    InvalidPdf,
    PdfTooLarge,
    InvalidPdfAnnotations,
    Conflict,
    MixedLineEndings,
    Io(io::Error),
    Write(String),
    LockPoisoned,
}

impl fmt::Display for VaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => write!(formatter, "文件路径无效或超出知识库范围"),
            Self::UnsupportedFile => write!(formatter, "仅支持 .md/.markdown、.canvas 画布或 .drawing 白板"),
            Self::UnsupportedMove => write!(formatter, "当前挂载不支持安全的目录移动；请使用支持防覆盖重命名的文件系统，WSL 建议将知识库放在 Linux 目录中"),
            Self::TooLarge => write!(formatter, "画布超过 4 MiB 或 1000 节点/3000 连接上限"),
            Self::InvalidDrawing => write!(formatter, "白板 JSON 格式或元素无效，原文已保留"),
            Self::DrawingTooLarge => write!(formatter, "白板超过 8 MiB、2000 元素或笔迹点数上限"),
            Self::InvalidCanvas => write!(formatter, "画布 JSON 结构无效，无法安全写入"),
            Self::InvalidPdf => write!(formatter, "请选择知识库内有效的 PDF 文件"),
            Self::PdfTooLarge => write!(formatter, "PDF 超过 32 MiB，请下载或用系统程序打开"),
            Self::InvalidPdfAnnotations => write!(formatter, "PDF 标注格式无效或超出容量，原标注已保留"),
            Self::InvalidUtf8 => write!(formatter, "文件不是有效的 UTF-8，无法安全打开"),
            Self::Conflict => write!(formatter, "文件已被外部修改，当前编辑未保存"),
            Self::MixedLineEndings => write!(
                formatter,
                "文件包含混合换行符，无法安全覆盖；请另存为新文件"
            ),
            Self::Io(error) if error.kind() == io::ErrorKind::NotFound => {
                write!(formatter, "文件不存在或已被删除")
            }
            Self::Io(error) => write!(formatter, "文件访问失败：{error}"),
            Self::Write(error) => write!(formatter, "保存失败：{error}"),
            Self::LockPoisoned => write!(formatter, "文件操作状态异常，请重试"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<io::Error> for VaultError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub path: String,
    pub content: String,
    pub version: String,
}

/// Noto writers share an OS lock; unrelated editors/sync tools remain independent.
pub struct Vault {
    root: PathBuf,
    writes: Mutex<()>,
}

// Never delete this file: replacing its inode would split the lock between writers.
const WRITE_LOCK_NAME: &str = ".noto-write.lock";
struct WriteGuard<'a> {
    _local: MutexGuard<'a, ()>,
    _file: fs::File,
}

impl Vault {
    fn lock_writes(&self) -> Result<WriteGuard<'_>, VaultError> {
        let local = self.writes.lock().map_err(|_| VaultError::LockPoisoned)?;
        let path = self.root.join(WRITE_LOCK_NAME);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() { return Err(VaultError::InvalidPath); }
        }
        let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        if !file.metadata()?.is_file() { return Err(VaultError::InvalidPath); }
        file.lock()?;
        Ok(WriteGuard { _local: local, _file: file })
    }
    pub fn open(root: impl AsRef<Path>) -> Result<Self, VaultError> {
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(VaultError::InvalidPath);
        }
        Ok(Self {
            root,
            writes: Mutex::new(()),
        })
    }

    fn resolve_note(&self, relative: &str) -> Result<PathBuf, VaultError> {
        let path = operations::validate_relative(relative)?;
        if !is_document_path(path) {
            return Err(VaultError::UnsupportedFile);
        }
        // Match the tree/item API: file symlinks must not change the document
        // type after extension checks or bypass its bounded read/write rules.
        if fs::symlink_metadata(self.root.join(path))?.file_type().is_symlink() {
            return Err(VaultError::InvalidPath);
        }
        // Canonicalize existing files so ordinary traversal and links outside the root are rejected.
        let resolved = fs::canonicalize(self.root.join(path))?;
        if !resolved.starts_with(&self.root) || !resolved.is_file() {
            return Err(VaultError::InvalidPath);
        }
        Ok(resolved)
    }

    pub fn read_note(&self, relative: &str) -> Result<Note, VaultError> {
        let _guard = self.writes.lock().map_err(|_| VaultError::LockPoisoned)?;
        let path = self.resolve_note(relative)?;
        let bytes = read_document_bytes(&path)?;
        let version = content_version(&bytes);
        let content = String::from_utf8(bytes).map_err(|_| VaultError::InvalidUtf8)?;
        let content = content
            .strip_prefix('\u{feff}')
            .unwrap_or(&content)
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        Ok(Note {
            path: relative.to_owned(),
            content,
            version,
        })
    }

    pub fn save_note(
        &self,
        relative: &str,
        content: &str,
        expected_version: &str,
    ) -> Result<Note, VaultError> {
        let _guard = self.lock_writes()?;
        let path = self.resolve_note(relative)?;
        let current = read_document_bytes(&path)?;
        check_document_write(&path, content)?;
        if content_version(&current) != expected_version {
            return Err(VaultError::Conflict);
        }
        // Do not replace a file whose original bytes could not be safely interpreted.
        let original = std::str::from_utf8(&current).map_err(|_| VaultError::InvalidUtf8)?;
        let has_crlf = original.contains("\r\n");
        let without_crlf = original.replace("\r\n", "");
        let has_lf = without_crlf.contains('\n');
        let has_cr = without_crlf.contains('\r');
        if u8::from(has_crlf) + u8::from(has_lf) + u8::from(has_cr) > 1 {
            return Err(VaultError::MixedLineEndings);
        }
        let ending = if has_crlf {
            "\r\n"
        } else if has_cr {
            "\r"
        } else {
            "\n"
        };
        let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let mut output = normalized.replace('\n', ending).into_bytes();
        if current.starts_with(&[0xef, 0xbb, 0xbf]) {
            output.splice(0..0, [0xef, 0xbb, 0xbf]);
        }
        check_document_size(&path, output.len())?;
        let permissions = fs::metadata(&path)?.permissions();
        if current != output && is_markdown_path(&path) {
            self.record_history(relative, &current, false)?;
        }
        AtomicFile::new(&path, AllowOverwrite)
            .write(|file| {
                file.write_all(&output)?;
                file.set_permissions(permissions.clone())?;
                Ok::<(), io::Error>(())
            })
            .map_err(|error| VaultError::Io(error.into()))?;
        Ok(Note {
            path: relative.to_owned(),
            content: normalized,
            version: content_version(&output),
        })
    }
}

pub const MAX_CANVAS_BYTES: usize = 4 * 1024 * 1024;
fn is_markdown_path(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}
pub fn is_canvas_path(path: &Path) -> bool {
    path.extension().and_then(|ext|ext.to_str()).is_some_and(|ext|ext.eq_ignore_ascii_case("canvas"))
}
pub fn is_drawing_path(path:&Path)->bool {path.extension().and_then(|ext|ext.to_str()).is_some_and(|ext|ext.eq_ignore_ascii_case("drawing"))}
pub fn is_document_path(path: &Path) -> bool {
    path.extension().and_then(|ext|ext.to_str()).is_some_and(|ext|["md","markdown","canvas","drawing"].iter().any(|v|ext.eq_ignore_ascii_case(v)))
}
fn check_document_size(path:&Path, bytes:usize) -> Result<(),VaultError> {
    if is_drawing_path(path)&&bytes>MAX_DRAWING_BYTES{return Err(VaultError::DrawingTooLarge);}
    if is_canvas_path(path)&&bytes>MAX_CANVAS_BYTES {Err(VaultError::TooLarge)} else {Ok(())}
}
fn check_document_write(path:&Path,content:&str) -> Result<(),VaultError> {
    check_document_size(path,content.len())?;
    if is_drawing_path(path){return drawing::check(content);}
    if !is_canvas_path(path){return Ok(());}
    let value:serde_json::Value=serde_json::from_str(content).map_err(|_|VaultError::InvalidCanvas)?;
    let root=value.as_object().ok_or(VaultError::InvalidCanvas)?;
    for (key,limit) in [("nodes",1000),("edges",3000)] {
        if let Some(value)=root.get(key) {
            let array=value.as_array().ok_or(VaultError::InvalidCanvas)?;
            if array.len()>limit{return Err(VaultError::TooLarge);}
        }
    }
    Ok(())
}
fn read_document_bytes(path:&Path) -> Result<Vec<u8>,VaultError> {
    if !is_canvas_path(path)&&!is_drawing_path(path) {return Ok(fs::read(path)?);}
    let limit=if is_drawing_path(path){MAX_DRAWING_BYTES}else{MAX_CANVAS_BYTES};
    let file=fs::File::open(path)?;
    check_document_size(path,file.metadata()?.len().try_into().unwrap_or(usize::MAX))?;
    let mut bytes=Vec::new();
    file.take(limit as u64+1).read_to_end(&mut bytes)?;
    check_document_size(path,bytes.len())?;
    Ok(bytes)
}

fn content_version(bytes: &[u8]) -> String {
    format!("sha256-{:x}", Sha256::digest(bytes))
}

/// The stage-0 applications use an isolated demo vault under the project directory.
pub fn demo_vault_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".local/demo-vault")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("项目")).unwrap();
        fs::write(dir.path().join("项目/样例.md"), "# 原文\n").unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        (dir, vault)
    }

    #[test]
    fn detects_an_external_change_without_overwriting_it() {
        let (dir, vault) = fixture();
        let note = vault.read_note("项目/样例.md").unwrap();
        fs::write(dir.path().join("项目/样例.md"), "# 外部修改\n").unwrap();
        assert!(matches!(
            vault.save_note("项目/样例.md", "# 本地编辑\n", &note.version),
            Err(VaultError::Conflict)
        ));
        assert_eq!(
            fs::read_to_string(dir.path().join("项目/样例.md")).unwrap(),
            "# 外部修改\n"
        );
    }

    #[test]
    fn refuses_traversal_and_invalid_utf8() {
        let (dir, vault) = fixture();
        assert!(matches!(
            vault.read_note("../outside.md"),
            Err(VaultError::InvalidPath)
        ));
        fs::write(dir.path().join("项目/样例.md"), [0xff]).unwrap();
        assert!(matches!(
            vault.read_note("项目/样例.md"),
            Err(VaultError::InvalidUtf8)
        ));
    }

    #[test]
    fn deleted_or_renamed_notes_are_not_recreated_by_save() {
        let (dir, vault) = fixture();
        let note = vault.read_note("项目/样例.md").unwrap();
        fs::rename(
            dir.path().join("项目/样例.md"),
            dir.path().join("项目/已重命名.md"),
        )
        .unwrap();
        assert!(vault
            .save_note("项目/样例.md", "未保存内容", &note.version)
            .is_err());
        assert!(!dir.path().join("项目/样例.md").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("项目/已重命名.md")).unwrap(),
            "# 原文\n"
        );

        let moved = vault.read_note("项目/已重命名.md").unwrap();
        fs::remove_file(dir.path().join("项目/已重命名.md")).unwrap();
        assert!(vault
            .save_note("项目/已重命名.md", "未保存内容", &moved.version)
            .is_err());
        assert!(!dir.path().join("项目/已重命名.md").exists());
        let copy = vault.create_note("项目/恢复.md", "未保存内容").unwrap();
        assert_eq!(copy.content, "未保存内容");
    }

    #[test]
    fn serializes_competing_saves_in_the_same_process() {
        let (_dir, vault) = fixture();
        let vault = Arc::new(vault);
        let version = vault.read_note("项目/样例.md").unwrap().version;
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = ["# 第一份", "# 第二份"]
            .into_iter()
            .map(|content| {
                let vault = Arc::clone(&vault);
                let barrier = Arc::clone(&barrier);
                let version = version.clone();
                thread::spawn(move || {
                    barrier.wait();
                    vault.save_note("项目/样例.md", content, &version)
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(VaultError::Conflict)))
                .count(),
            1
        );
    }
    #[test]
    fn canvas_document_versions_capacity_and_original_bytes_are_protected() {
        let dir=tempfile::tempdir().unwrap();let vault=Vault::open(dir.path()).unwrap();
        let note=vault.create_note("主题.canvas",r#"{"nodes":[],"edges":[]}"#).unwrap();
        assert!(vault.create_note("主题.canvas","{}").is_err());
        assert_eq!(vault.read_note("主题.canvas").unwrap().content,note.content);
        fs::write(dir.path().join("主题.canvas"),r#"{"nodes":[],"external":1}"#).unwrap();
        assert!(matches!(vault.save_note("主题.canvas","{}",&note.version),Err(VaultError::Conflict)));
        let current=vault.read_note("主题.canvas").unwrap();
        assert!(matches!(vault.save_note("主题.canvas","{bad",&current.version),Err(VaultError::InvalidCanvas)));
        let too_many=serde_json::json!({"nodes":vec![serde_json::Value::Null;1001],"edges":[]}).to_string();
        assert!(matches!(vault.create_note("节点超限.canvas",&too_many),Err(VaultError::TooLarge)));
        assert!(!dir.path().join("节点超限.canvas").exists());
        assert!(matches!(vault.save_note("主题.canvas",&"x".repeat(MAX_CANVAS_BYTES+1),&current.version),Err(VaultError::TooLarge)));
        assert_eq!(vault.read_note("主题.canvas").unwrap().content,current.content);
        assert!(matches!(vault.create_note("超限.canvas",&"x".repeat(MAX_CANVAS_BYTES+1)),Err(VaultError::TooLarge)));
        assert!(!dir.path().join("超限.canvas").exists());
        assert!(matches!(vault.create_note("a.json","{}"),Err(VaultError::UnsupportedFile)));
        fs::write(dir.path().join("主题.canvas"),"{broken").unwrap();
        assert_eq!(vault.read_note("主题.canvas").unwrap().content,"{broken");
        fs::File::create(dir.path().join("大文件.canvas")).unwrap().set_len(MAX_CANVAS_BYTES as u64+1).unwrap();
        assert!(matches!(vault.read_note("大文件.canvas"),Err(VaultError::TooLarge)));
    }
    #[test]
    fn canvas_attachment_source_uses_shared_collision_and_path_guards() {
        let dir=tempfile::tempdir().unwrap();let vault=Vault::open(dir.path()).unwrap();
        vault.create_directory("画布").unwrap();vault.create_note("画布/a.canvas","{}").unwrap();
        let a=vault.import_attachment_bytes("画布/a.canvas","100% #.png",b"first").unwrap();
        let b=vault.import_attachment_bytes("画布/a.canvas","100% #.png",b"second").unwrap();
        assert_ne!(a,b);assert_eq!(fs::read(vault.attachment_path("画布/a.canvas",&a).unwrap()).unwrap(),b"first");
        assert!(vault.attachment_path("画布/a.canvas","../../outside.png").is_err());
        assert!(vault.read_note("../a.canvas").is_err());
    }

    #[test]
    fn migration_backup_preserves_bom_and_line_endings_and_never_overwrites() {
        let dir=tempfile::tempdir().unwrap();let vault=Vault::open(dir.path()).unwrap();
        vault.create_directory("nested").unwrap();vault.create_note("nested/a.canvas","{}").unwrap();
        let bytes="\u{feff}{\r\n  \"nodes\": [], \"edges\": []\r\n}\r\n".as_bytes();
        fs::write(dir.path().join("nested/a.canvas"),bytes).unwrap();
        let note=vault.read_note("nested/a.canvas").unwrap();
        let backup=".noto-structure-backup-test";
        vault.backup_document("nested/a.canvas",backup,&note.version).unwrap();
        let file=dir.path().join(backup).join("原文/nested/a.canvas");
        assert_eq!(fs::read(&file).unwrap(),bytes);
        assert!(vault.backup_document("nested/a.canvas",backup,&note.version).is_err());
        assert_eq!(fs::read(&file).unwrap(),bytes);
        assert!(matches!(vault.backup_document("nested/a.canvas",".noto-structure-backup-stale","old"),Err(VaultError::Conflict)));
        assert!(!dir.path().join(".noto-structure-backup-stale").exists());
        assert!(vault.backup_document("nested/a.canvas","../outside",&note.version).is_err());
        #[cfg(unix)] {
            let outside=tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(),dir.path().join(".noto-structure-backup-link")).unwrap();
            assert!(vault.backup_document("nested/a.canvas",".noto-structure-backup-link",&note.version).is_err());
            assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
        }
    }

}
