use super::{content_version, operations::validate_relative, Vault, VaultError};
use atomicwrites::{AtomicFile, DisallowOverwrite};
use serde::{Deserialize, Serialize};
use std::{fs, io::{self, Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

pub(crate) const HISTORY_DIR: &str = ".noto-history";
pub const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 20;
const MAX_AGE: u64 = 7 * 24 * 60 * 60 * 1000;
const INTERVAL: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub created_at: u64,
    pub size: u64,
    pub reason: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    #[serde(flatten)]
    pub entry: HistoryEntry,
    pub content: String,
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().try_into().unwrap_or(u64::MAX) }
fn markdown(path: &str) -> Result<(), VaultError> {
    let path = validate_relative(path)?;
    if !path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("md") || v.eq_ignore_ascii_case("markdown")) {
        return Err(VaultError::UnsupportedFile);
    }
    Ok(())
}
fn id_parts(id: &str) -> Option<(u64, &str, &str)> {
    let parts: Vec<_> = id.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 20 || !parts[0].bytes().all(|v| v.is_ascii_digit())
        || parts[1].len() != 64 || !parts[1].bytes().all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
        || !["s", "r"].contains(&parts[2]) { return None; }
    Some((parts[0].parse().ok()?, parts[1], parts[2]))
}
fn directory(path: &Path, create: bool) -> Result<bool, VaultError> {
    if create {
        match fs::create_dir(path) { Ok(()) => (), Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (), Err(e) => return Err(e.into()) }
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(VaultError::InvalidPath),
        Err(e) if !create && e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
impl Vault {
    fn history_directory(&self, relative: &str, create: bool) -> Result<Option<PathBuf>, VaultError> {
        markdown(relative)?;
        let root = self.root.join(HISTORY_DIR);
        if !directory(&root, create)? { return Ok(None); }
        let path = root.join(content_version(relative.as_bytes()).trim_start_matches("sha256-"));
        if !directory(&path, create)? { return Ok(None); }
        Ok(Some(path))
    }
    fn history_entries(&self, relative: &str) -> Result<Vec<HistoryEntry>, VaultError> {
        let Some(folder) = self.history_directory(relative, false)? else { return Ok(vec![]); };
        let mut result = vec![];
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str() else { continue; };
            let Some((created_at, _, reason)) = id_parts(id) else { continue; };
            let meta = fs::symlink_metadata(entry.path())?;
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_SNAPSHOT_BYTES as u64 { continue; }
            result.push(HistoryEntry { id: id.to_owned(), created_at, size: meta.len(), reason: if reason == "r" { "restore" } else { "save" }.into() });
        }
        result.sort_by(|a,b| b.created_at.cmp(&a.created_at));
        Ok(result)
    }
    pub fn file_history(&self, relative: &str) -> Result<Vec<HistoryEntry>, VaultError> {
        let _guard = self.writes.lock().map_err(|_| VaultError::LockPoisoned)?;
        Ok(self.history_entries(relative)?.into_iter().filter(|e| now().saturating_sub(e.created_at) <= MAX_AGE).take(MAX_ENTRIES).collect())
    }
    pub fn read_history(&self, relative: &str, id: &str) -> Result<HistorySnapshot, VaultError> {
        let _guard = self.writes.lock().map_err(|_| VaultError::LockPoisoned)?;
        let (created_at, hash, reason) = id_parts(id).ok_or(VaultError::InvalidPath)?;
        if now().saturating_sub(created_at) > MAX_AGE { return Err(io::Error::new(io::ErrorKind::NotFound, "快照已过期").into()); }
        let folder = self.history_directory(relative, false)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "没有快照"))?;
        let path = folder.join(id);
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.file_type().is_symlink() { return Err(VaultError::InvalidPath); }
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(MAX_SNAPSHOT_BYTES as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES || content_version(&bytes) != format!("sha256-{hash}") {
            return Err(VaultError::Write("恢复快照损坏，原笔记未修改".into()));
        }
        let size = bytes.len() as u64;
        let content = String::from_utf8(bytes).map_err(|_| VaultError::InvalidUtf8)?;
        Ok(HistorySnapshot { entry: HistoryEntry { id: id.into(), created_at, size, reason: if reason == "r" { "restore" } else { "save" }.into() }, content: content.strip_prefix('\u{feff}').unwrap_or(&content).replace("\r\n", "\n").replace('\r', "\n") })
    }
    // Caller holds the vault OS write lock. Snapshot data is published atomically.
    pub(crate) fn record_history(&self, relative: &str, bytes: &[u8], force: bool) -> Result<(), VaultError> {
        self.record_history_at(relative, bytes, force, now())
    }
    fn record_history_at(&self, relative: &str, bytes: &[u8], force: bool, clock: u64) -> Result<(), VaultError> {
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            if force { return Err(VaultError::Write("当前内容超过 2 MiB 快照上限，请先另存后再还原".into())); }
            return Ok(());
        }
        if !force && std::str::from_utf8(bytes).map_err(|_| VaultError::InvalidUtf8)?.trim_matches('\u{feff}').trim().is_empty() { return Ok(()); }
        let mut entries = self.history_entries(relative)?;
        let hash = content_version(bytes);
        let unchanged = entries.first().is_some_and(|entry| clock.saturating_sub(entry.created_at) <= MAX_AGE && id_parts(&entry.id).is_some_and(|(_, previous, _)| hash == format!("sha256-{previous}")));
        let throttled = !force && entries.first().is_some_and(|entry| clock.saturating_sub(entry.created_at) < INTERVAL);
        if !unchanged && !throttled {
            let timestamp = clock.max(entries.first().map_or(0, |e| e.created_at.saturating_add(1)));
            let id = format!("{timestamp:020}-{}-{}", hash.trim_start_matches("sha256-"), if force { "r" } else { "s" });
            let folder = self.history_directory(relative, true)?.unwrap();
            AtomicFile::new(&folder.join(&id), DisallowOverwrite).write(|file| file.write_all(bytes)).map_err(|e| VaultError::Io(e.into()))?;
            entries.insert(0, HistoryEntry { id, created_at: timestamp, size: bytes.len() as u64, reason: String::new() });
        }
        if !entries.is_empty() {
            let folder = self.history_directory(relative, false)?.unwrap();
            let mut retained = 0; let mut size = 0;
            for entry in entries {
                if retained < MAX_ENTRIES && size + entry.size <= MAX_FILE_BYTES && clock.saturating_sub(entry.created_at) <= MAX_AGE {
                    retained += 1; size += entry.size;
                } else { fs::remove_file(folder.join(entry.id))?; }
            }
        }
        Ok(())
    }
    /// Protect both the on-disk version and current editor text before restoring.
    /// This command never overwrites the note; restoration uses the existing editor/save path.
    pub fn checkpoint_history(&self, relative: &str, content: &str, expected_version: &str) -> Result<(), VaultError> {
        markdown(relative)?;
        if content.len() > MAX_SNAPSHOT_BYTES { return Err(VaultError::Write("当前内容超过 2 MiB 快照上限，请先另存后再还原".into())); }
        let _guard = self.lock_writes()?;
        let path = self.resolve_note(relative)?;
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(MAX_SNAPSHOT_BYTES as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES { return Err(VaultError::Write("当前文件超过 2 MiB 快照上限，请先另存后再还原".into())); }
        if content_version(&bytes) != expected_version { return Err(VaultError::Conflict); }
        std::str::from_utf8(&bytes).map_err(|_| VaultError::InvalidUtf8)?;
        self.record_history(relative, &bytes, true)?;
        self.record_history(relative, content.as_bytes(), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_throttled_bounded_and_restore_checkpoints_keep_current_work() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path()).unwrap();
        let note = vault.create_note("中文.md", "原始内容").unwrap();
        let saved = vault.save_note("中文.md", "新内容", &note.version).unwrap();
        let entries = vault.file_history("中文.md").unwrap(); assert_eq!(entries.len(), 1);
        assert_eq!(vault.read_history("中文.md", &entries[0].id).unwrap().content, "原始内容");
        vault.save_note("中文.md", "再次保存", &saved.version).unwrap(); assert_eq!(vault.file_history("中文.md").unwrap().len(), 1);
        let disk = vault.read_note("中文.md").unwrap();
        assert!(matches!(vault.checkpoint_history("中文.md", "不应存入", "old"), Err(VaultError::Conflict)));
        vault.checkpoint_history("中文.md", "当前未保存编辑", &disk.version).unwrap();
        let entries = vault.file_history("中文.md").unwrap();
        assert_eq!(vault.read_history("中文.md", &entries[0].id).unwrap().content, "当前未保存编辑");
        assert_eq!(vault.read_note("中文.md").unwrap().content, "再次保存");
        assert!(vault.file_history("other.md").unwrap().is_empty());
        assert!(vault.read_history("中文.md", "../outside").is_err());
        for i in 0..25 { vault.checkpoint_history("中文.md", &format!("编辑 {i}"), &disk.version).unwrap(); }
        assert_eq!(vault.file_history("中文.md").unwrap().len(), MAX_ENTRIES);
        assert!(vault.list().unwrap().iter().all(|e| e.name != HISTORY_DIR));
    }
    #[test]
    fn raw_encoding_integrity_age_and_large_notes_remain_safe() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "\u{feff}旧文\r\n下一行\r\n").unwrap();
        let note = vault.read_note("a.md").unwrap(); vault.save_note("a.md", "新文", &note.version).unwrap();
        let entry = vault.file_history("a.md").unwrap().remove(0);
        assert_eq!(vault.read_history("a.md", &entry.id).unwrap().content, "旧文\n下一行\n");
        let folder = vault.history_directory("a.md", false).unwrap().unwrap();
        fs::write(folder.join(entry.id.clone()), "损坏内容").unwrap(); assert!(vault.read_history("a.md", &entry.id).is_err());
        vault.record_history_at("a.md", b"later", true, now() + MAX_AGE + 1).unwrap(); assert!(!folder.join(entry.id).exists());
        let large = "x".repeat(MAX_SNAPSHOT_BYTES + 1); let big = vault.create_note("big.md", &large).unwrap();
        vault.save_note("big.md", "正常保存不受快照上限影响", &big.version).unwrap(); assert!(vault.file_history("big.md").unwrap().is_empty());
        assert!(vault.file_history("../a.md").is_err()); assert!(vault.file_history("x.canvas").is_err());
        assert!(vault.create_note(".noto-history/a.md", "不得公开写入").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn history_directories_and_records_never_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap(); let note = vault.create_note("a.md", "原文").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(HISTORY_DIR)).unwrap();
        assert!(vault.save_note("a.md", "不得覆盖", &note.version).is_err());
        assert_eq!(vault.read_note("a.md").unwrap().content, "原文"); assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    #[test]
    fn retention_budget_expired_duplicates_and_snapshot_failures_preserve_notes() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path()).unwrap();
        let note = vault.create_note("a.md", "磁盘内容").unwrap();
        let clock = now();
        vault.record_history_at("a.md", b"same", true, clock - MAX_AGE - 1).unwrap();
        vault.record_history_at("a.md", b"same", true, clock).unwrap();
        let entries = vault.file_history("a.md").unwrap(); assert_eq!(entries.len(), 1);
        assert_eq!(vault.read_history("a.md", &entries[0].id).unwrap().content, "same");
        for i in 0..12 {
            let mut bytes = vec![b'x'; MAX_SNAPSHOT_BYTES]; bytes[0] = b'a' + i;
            vault.record_history_at("a.md", &bytes, true, clock + i as u64 + 1).unwrap();
        }
        let entries = vault.file_history("a.md").unwrap();
        assert_eq!(entries.len(), 8); assert!(entries.iter().map(|v| v.size).sum::<u64>() <= MAX_FILE_BYTES);
        assert_eq!(vault.read_note("a.md").unwrap().version, note.version);
        let other = tempfile::tempdir().unwrap(); let blocked = Vault::open(other.path()).unwrap();
        let original = blocked.create_note("b.md", "原文").unwrap();
        fs::write(other.path().join(HISTORY_DIR), "不是目录").unwrap();
        assert!(blocked.save_note("b.md", "新文", &original.version).is_err());
        assert_eq!(blocked.read_note("b.md").unwrap().content, "原文");
    }
}
