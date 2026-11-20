use super::{check_document_write, content_version, is_document_path, read_document_bytes, Note, Vault, VaultError};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub children: Vec<VaultEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
}

pub(crate) fn validate_relative(path: &str) -> Result<&Path, VaultError> {
    if path.contains(['\\', ':']) || path.chars().any(char::is_control)
        || path.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part == super::WRITE_LOCK_NAME || part == super::history::HISTORY_DIR || part == super::webdav::STATE_DIR || part.eq_ignore_ascii_case(super::activity::LEGACY_ACTIVITY_DIR)) {
        return Err(VaultError::InvalidPath);
    }
    let path = Path::new(path);
    if path.as_os_str().is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(VaultError::InvalidPath);
    }
    Ok(path)
}

impl Vault {
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve an existing item without allowing a symlink to escape the vault.
    pub fn item_path(&self, relative: &str) -> Result<PathBuf, VaultError> {
        let path = self.root.join(validate_relative(relative)?);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(VaultError::InvalidPath);
        }
        let resolved = fs::canonicalize(path)?;
        if !resolved.starts_with(&self.root) || resolved == self.root {
            return Err(VaultError::InvalidPath);
        }
        Ok(resolved)
    }

    fn new_path(&self, relative: &str) -> Result<PathBuf, VaultError> {
        let path = validate_relative(relative)?;
        let parent = path.parent().ok_or(VaultError::InvalidPath)?;
        let parent = fs::canonicalize(self.root.join(parent))?;
        if !parent.starts_with(&self.root) || !parent.is_dir() {
            return Err(VaultError::InvalidPath);
        }
        Ok(parent.join(path.file_name().ok_or(VaultError::InvalidPath)?))
    }

    pub fn list(&self) -> Result<Vec<VaultEntry>, VaultError> {
        fn visit(root: &Path, dir: &Path) -> Result<Vec<VaultEntry>, VaultError> {
            let mut entries = Vec::new();
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                // Don't recursively follow symlinks or expose hidden application data.
                if kind.is_symlink() {
                    continue;
                }
                let raw_name = entry.file_name();
                let name = raw_name.to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                let entry_path = entry.path();
                let relative = entry_path.strip_prefix(root).map_err(|_| VaultError::InvalidPath)?
                    .components().map(|part| part.as_os_str().to_str()).collect::<Option<Vec<_>>>()
                    .map(|parts| parts.join("/")).unwrap_or_default();
                let issue = if raw_name.to_str().is_none() {
                    Some("文件名不是有效 UTF-8，请在文件管理器中改名后打开".to_owned())
                } else if validate_relative(&relative).is_err() {
                    Some("文件名含不支持的反斜杠、冒号或控制字符，请在文件管理器中改名后打开".to_owned())
                } else { None };
                entries.push(VaultEntry {
                    path: relative,
                    name,
                    is_directory: kind.is_dir(),
                    children: if kind.is_dir() && issue.is_none() {
                        visit(root, &entry.path())?
                    } else {
                        Vec::new()
                    },
                    issue,
                });
            }
            entries.sort_by(|a, b| {
                b.is_directory
                    .cmp(&a.is_directory)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            Ok(entries)
        }
        visit(&self.root, &self.root)
    }

    pub fn create_note(&self, relative: &str, content: &str) -> Result<Note, VaultError> {
        let _guard = self.lock_writes()?;
        if !is_document_path(validate_relative(relative)?) {
            return Err(VaultError::UnsupportedFile);
        }
        let path = self.new_path(relative)?;
        check_document_write(&path, content)?;
        let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(normalized.as_bytes())?;
        file.sync_all()?;
        Ok(Note {
            path: relative.to_owned(),
            version: content_version(normalized.as_bytes()),
            content: normalized,
        })
    }

    /// Copy original bytes only into an internal migration backup, never overwrite.
    pub fn backup_document(&self,relative:&str,backup_root:&str,expected_version:&str)->Result<(),VaultError>{
        if !backup_root.starts_with(".noto-structure-backup-")||backup_root.len()>128||!backup_root.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'.'||b==b'-') {
            return Err(VaultError::InvalidPath);
        }
        let _guard=self.lock_writes()?;
        let source=self.resolve_note(relative)?;let bytes=read_document_bytes(&source)?;
        if content_version(&bytes)!=expected_version{return Err(VaultError::Conflict);}
        let relative_path=validate_relative(relative)?;
        let mut directory=self.root.clone();
        let mut parts=vec![Path::new(backup_root),Path::new("原文")];
        if let Some(parent)=relative_path.parent(){parts.push(parent);}
        for part in parts {
            for component in part.components(){
                let Component::Normal(name)=component else{return Err(VaultError::InvalidPath);};
                let candidate=directory.join(name);
                if let Ok(meta)=fs::symlink_metadata(&candidate){if meta.file_type().is_symlink(){return Err(VaultError::InvalidPath);}}
                match fs::create_dir(&candidate){Ok(())=>(),Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>(),Err(e)=>return Err(e.into())}
                let canonical=fs::canonicalize(candidate)?;
                if !canonical.starts_with(&self.root)||!canonical.is_dir(){return Err(VaultError::InvalidPath);}
                directory=canonical;
            }
        }
        let mut file=OpenOptions::new().write(true).create_new(true).open(directory.join(relative_path.file_name().ok_or(VaultError::InvalidPath)?))?;
        file.write_all(&bytes)?;file.sync_all()?;Ok(())
    }

    pub fn create_directory(&self, relative: &str) -> Result<(), VaultError> {
        let _guard = self.lock_writes()?;
        fs::create_dir(self.new_path(relative)?)?;
        Ok(())
    }

    pub fn move_item(&self, from: &str, to: &str) -> Result<(), VaultError> {
        let _guard = self.lock_writes()?;
        let source = self.item_path(from)?;
        let target = self.new_path(to)?;
        if target.try_exists()? {
            return Err(VaultError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "目标已存在",
            )));
        }
        if source.is_dir() && target.starts_with(&source) {
            return Err(VaultError::InvalidPath);
        }
        // Keep an external writer from creating the destination between our
        // existence check and the move. Fail instead of replacing that file.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if source.is_dir() {
            // atomicwrites falls back to hard links when RENAME_NOREPLACE is
            // unavailable; directories cannot be hard-linked. Fail explicitly
            // on such mounts (e.g. WSL DrvFS), rather than replacing an empty
            // destination with an unguarded rename.
            use rustix::fs::{renameat_with, RenameFlags, CWD};
            return match renameat_with(CWD, &source, CWD, &target, RenameFlags::NOREPLACE) {
                Ok(()) => Ok(()),
                Err(
                    rustix::io::Errno::INVAL
                    | rustix::io::Errno::NOSYS
                    | rustix::io::Errno::OPNOTSUPP,
                ) => Err(VaultError::UnsupportedMove),
                Err(error) => Err(std::io::Error::from(error).into()),
            };
        }
        atomicwrites::move_atomic(&source, &target)?;
        Ok(())
    }

    /// Copies a user-selected attachment without overwriting an existing file.
    pub fn import_attachment(&self, note: &str, source: &Path) -> Result<String, VaultError> {
        if !source.is_file() {
            return Err(VaultError::InvalidPath);
        }
        let file_name = source
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or(VaultError::InvalidPath)?;
        self.import_attachment_reader(note, file_name, &mut fs::File::open(source)?)
    }

    /// Clipboard/drop bytes use the same paths and collision protection as file imports.
    pub fn import_attachment_bytes(
        &self,
        note: &str,
        name: &str,
        data: &[u8],
    ) -> Result<String, VaultError> {
        self.import_attachment_reader(note, name, &mut std::io::Cursor::new(data))
    }

    fn import_attachment_reader(
        &self,
        note: &str,
        file_name: &str,
        input: &mut impl std::io::Read,
    ) -> Result<String, VaultError> {
        if file_name.is_empty()
            || file_name.starts_with('.')
            || file_name.contains(['/', '\\', ':'])
            || file_name.chars().any(char::is_control)
        {
            return Err(VaultError::InvalidPath);
        }
        let _guard = self.lock_writes()?;
        self.resolve_note(note)?;
        let note_parent = Path::new(note).parent().ok_or(VaultError::InvalidPath)?;
        let attachment_dir = note_parent.join("attachments");
        let absolute_dir = self.root.join(&attachment_dir);
        match fs::create_dir(&absolute_dir) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        let real_dir = fs::canonicalize(&absolute_dir)?;
        if !real_dir.starts_with(&self.root) || !real_dir.is_dir() {
            return Err(VaultError::InvalidPath);
        }
        let name = Path::new(file_name);
        let stem = name
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or("attachment");
        let ext = name.extension().and_then(|v| v.to_str());
        for index in 0..10_000 {
            let candidate = if index == 0 {
                file_name.to_owned()
            } else {
                match ext {
                    Some(ext) => format!("{stem} ({index}).{ext}"),
                    None => format!("{stem} ({index})"),
                }
            };
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(real_dir.join(&candidate))
            {
                Ok(mut destination) => {
                    std::io::copy(input, &mut destination)?;
                    destination.sync_all()?;
                    return Ok(format!("attachments/{candidate}"));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err(VaultError::Write("同名附件过多".into()))
    }

    /// Markdown attachment paths are relative to the note, and must stay within the vault.
    pub fn attachment_path(&self, note: &str, link: &str) -> Result<PathBuf, VaultError> {
        validate_relative(note)?;
        if link.is_empty() || link.contains([':', '\\']) || link.starts_with('/') {
            return Err(VaultError::InvalidPath);
        }
        let mut relative = Path::new(note)
            .parent()
            .ok_or(VaultError::InvalidPath)?
            .to_path_buf();
        for component in Path::new(link).components() {
            match component {
                Component::Normal(part) => relative.push(part),
                Component::CurDir => (),
                Component::ParentDir if relative.pop() => (),
                _ => return Err(VaultError::InvalidPath),
            }
        }
        let resolved = fs::canonicalize(self.root.join(relative))?;
        if !resolved.starts_with(&self.root) || !resolved.is_file() {
            return Err(VaultError::InvalidPath);
        }
        Ok(resolved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_attachments_keep_existing_bytes_and_reject_paths() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.create_note("笔记.md", "原文").unwrap();
        let first = vault
            .import_attachment_bytes("笔记.md", "图片.png", &[1, 2, 3])
            .unwrap();
        let next = vault
            .import_attachment_bytes("笔记.md", "图片.png", &[4, 5])
            .unwrap();
        assert_ne!(first, next);
        assert_eq!(
            fs::read(vault.attachment_path("笔记.md", &first).unwrap()).unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            fs::read(vault.attachment_path("笔记.md", &next).unwrap()).unwrap(),
            [4, 5]
        );
        for name in [
            "../escape.png",
            "a/b.png",
            "C:bad.png",
            ".hidden",
            "bad\n.png",
            "",
        ] {
            assert!(vault
                .import_attachment_bytes("笔记.md", name, &[9])
                .is_err());
        }
        assert_eq!(vault.read_note("笔记.md").unwrap().content, "原文");
    }

    #[test]
    fn create_move_and_attachments_do_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("图 片.png"), [1, 2, 3]).unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.create_directory("项目").unwrap();
        vault.create_note("项目/笔记.md", "正文").unwrap();
        assert!(vault.create_note("项目/笔记.md", "覆盖").is_err());
        let first = vault
            .import_attachment("项目/笔记.md", &source.path().join("图 片.png"))
            .unwrap();
        let second = vault
            .import_attachment("项目/笔记.md", &source.path().join("图 片.png"))
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            fs::read(vault.attachment_path("项目/笔记.md", &first).unwrap()).unwrap(),
            [1, 2, 3]
        );
        assert!(vault
            .attachment_path("项目/笔记.md", "../../outside.png")
            .is_err());
        vault.create_note("项目/已有.md", "已有").unwrap();
        assert!(vault.move_item("项目/笔记.md", "项目/已有.md").is_err());
        vault.move_item("项目/笔记.md", "项目/新名.md").unwrap();
        assert_eq!(vault.read_note("项目/新名.md").unwrap().content, "正文");
        vault.move_item("项目", "新的项目").unwrap();
        assert_eq!(vault.read_note("新的项目/新名.md").unwrap().content, "正文");
        assert_eq!(
            fs::read(vault.attachment_path("新的项目/新名.md", &first).unwrap()).unwrap(),
            [1, 2, 3]
        );
    }

    #[test]
    fn preserves_utf8_bom_and_consistent_windows_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"\xef\xbb\xbfline 1\r\nline 2\r\n").unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let note = vault.read_note("note.md").unwrap();
        assert_eq!(note.content, "line 1\nline 2\n");
        vault
            .save_note("note.md", "changed\nsecond\n", &note.version)
            .unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"\xef\xbb\xbfchanged\r\nsecond\r\n"
        );
        fs::write(&path, b"mixed\r\nline\n").unwrap();
        let note = vault.read_note("note.md").unwrap();
        assert!(matches!(
            vault.save_note("note.md", "edit", &note.version),
            Err(VaultError::MixedLineEndings)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"mixed\r\nline\n");
    }
}
