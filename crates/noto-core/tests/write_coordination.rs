use noto_core::{Vault, VaultError};
use std::{fs, path::Path, process::{Command, Stdio}, thread, time::{Duration, Instant}};

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.exists() {
        assert!(Instant::now() < deadline, "writer did not become ready: {}", path.display());
        thread::sleep(Duration::from_millis(5));
    }
}

// Each invocation has its own Vault and process-local mutex.
#[test]
fn writer_process() {
    let Some(root) = std::env::var_os("NOTO_WRITE_TEST_ROOT") else { return };
    let root = Path::new(&root);
    let id = std::env::var("NOTO_WRITE_TEST_ID").unwrap();
    let vault = Vault::open(root).unwrap();
    let version = vault.read_note("并发.md").unwrap().version;
    if id == "hold" {
        let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join(".noto-write.lock")).unwrap();
        lock.lock().unwrap();
        fs::write(root.join(".ready-hold"), "ready").unwrap();
        thread::sleep(Duration::from_secs(60));
        return;
    }
    fs::write(root.join(format!(".ready-{id}")), "ready").unwrap();
    wait_for(&root.join(".start"));
    let result = vault.save_note("并发.md", &id.repeat(200_000), &version);
    let status = match result { Ok(_) => "saved", Err(VaultError::Conflict) => "conflict", Err(error) => panic!("unexpected save failure: {error}") };
    fs::write(root.join(format!(".result-{id}")), status).unwrap();
}

fn writer(root: &Path, id: &str) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap()).args(["--exact", "writer_process", "--nocapture"])
        .env("NOTO_WRITE_TEST_ROOT", root).env("NOTO_WRITE_TEST_ID", id)
        .stdout(Stdio::null()).spawn().unwrap()
}

#[test]
fn competing_processes_accept_only_one_copy_of_the_same_version() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("并发.md"), "原文".repeat(100_000)).unwrap();
    let mut a = writer(dir.path(), "A");
    let mut b = writer(dir.path(), "B");
    wait_for(&dir.path().join(".ready-A"));
    wait_for(&dir.path().join(".ready-B"));
    fs::write(dir.path().join(".start"), "go").unwrap();
    assert!(a.wait().unwrap().success());
    assert!(b.wait().unwrap().success());
    let outcomes = [fs::read_to_string(dir.path().join(".result-A")).unwrap(), fs::read_to_string(dir.path().join(".result-B")).unwrap()];
    assert_eq!(outcomes.iter().filter(|value| value.as_str() == "saved").count(), 1);
    assert_eq!(outcomes.iter().filter(|value| value.as_str() == "conflict").count(), 1);
    let disk = fs::read_to_string(dir.path().join("并发.md")).unwrap();
    assert!(disk == "A".repeat(200_000) || disk == "B".repeat(200_000));
    assert!(!Vault::open(dir.path()).unwrap().list().unwrap().iter().any(|entry| entry.name == ".noto-write.lock"));
}

#[test]
fn terminated_writer_releases_the_os_lock() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("并发.md"), "原文").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let note = vault.read_note("并发.md").unwrap();
    assert!(!dir.path().join(".noto-write.lock").exists());
    let mut child = writer(dir.path(), "hold");
    wait_for(&dir.path().join(".ready-hold"));
    child.kill().unwrap(); child.wait().unwrap();
    assert!(vault.save_note("并发.md", "恢复保存", &note.version).is_ok());
}

#[test]
fn public_paths_reject_ambiguous_separators_and_reserved_lock() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    for path in [r"项目\笔记.md", "项目:纪要.md", "a//b.md", "a/./b.md", "a/../b.md", ".noto-write.lock", "bad\n.md"] {
        assert!(matches!(vault.create_note(path, "不得创建"), Err(VaultError::InvalidPath)));
        assert!(matches!(vault.read_note(path), Err(VaultError::InvalidPath)));
        assert!(matches!(vault.item_path(path), Err(VaultError::InvalidPath)));
    }
}

#[cfg(unix)]
#[test]
fn unix_names_are_diagnosed_without_aliasing_other_files() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("项目")).unwrap();
    fs::write(dir.path().join("项目/笔记.md"), "正常正文").unwrap();
    fs::write(dir.path().join(r"项目\笔记.md"), "特殊文件").unwrap();
    fs::write(dir.path().join("项目:纪要.md"), "冒号文件").unwrap();
    fs::write(dir.path().join(OsString::from_vec(b"bad-\xff.md".to_vec())), "非UTF8名称").unwrap();
    fs::write(dir.path().join("bad-�.md"), "合法UTF8文件名").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let entries = vault.list().unwrap();
    let special = entries.iter().find(|entry| entry.name == r"项目\笔记.md").unwrap();
    assert_eq!(special.path, r"项目\笔记.md");
    assert!(special.issue.is_some());
    assert!(vault.read_note(&special.path).is_err());
    assert_eq!(entries.iter().filter(|entry| entry.issue.is_some()).count(), 3);
    let invalid_utf8 = entries.iter().find(|entry| entry.path.is_empty()).unwrap();
    assert!(invalid_utf8.issue.is_some());
    assert!(vault.read_note(&invalid_utf8.path).is_err());
    assert_eq!(vault.read_note("bad-�.md").unwrap().content, "合法UTF8文件名");
    assert_eq!(vault.read_note("项目/笔记.md").unwrap().content, "正常正文");
    let outside = tempfile::tempdir().unwrap();
    fs::remove_file(dir.path().join(".noto-write.lock")).ok();
    std::os::unix::fs::symlink(outside.path().join("lock"), dir.path().join(".noto-write.lock")).unwrap();
    assert!(vault.create_directory("不会创建").is_err());
    assert!(!outside.path().join("lock").exists());
}
