use serde::Serialize;
use std::{
    fs,
    io::{self, ErrorKind, Write},
    path::Path,
};

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum CheckStatus {
    Ok,
    Missing,
    NotDirectory,
    PermissionDenied,
    ReadOnly,
    StorageFull,
    CleanupFailed,
    Failed,
}

impl CheckStatus {
    fn from_error(error: io::Error) -> Self {
        match error.kind() {
            ErrorKind::NotFound => Self::Missing,
            ErrorKind::NotADirectory => Self::NotDirectory,
            ErrorKind::PermissionDenied => Self::PermissionDenied,
            ErrorKind::ReadOnlyFilesystem => Self::ReadOnly,
            ErrorKind::StorageFull | ErrorKind::QuotaExceeded => Self::StorageFull,
            _ => Self::Failed,
        }
    }
}

#[derive(Debug, Serialize)]
struct DirectoryCheck {
    path: String,
    read: CheckStatus,
    write: CheckStatus,
}

#[derive(Debug, Serialize)]
pub struct StorageDiagnostics {
    vault: Option<DirectoryCheck>,
    data: DirectoryCheck,
}

impl StorageDiagnostics {
    pub fn probe(vault: Option<&Path>, data: &Path) -> Self {
        Self {
            vault: vault.map(check_directory),
            data: check_directory(data),
        }
    }
}

fn check_directory(path: &Path) -> DirectoryCheck {
    let (read, write) = match fs::metadata(path) {
        Ok(meta) if meta.is_dir() => {
            let read = match fs::read_dir(path).and_then(|mut entries| entries.next().transpose()) {
                Ok(_) => CheckStatus::Ok,
                Err(error) => CheckStatus::from_error(error),
            };
            (read, check_write(path))
        }
        other => {
            let check = match other {
                Ok(_) => CheckStatus::NotDirectory,
                Err(error) => CheckStatus::from_error(error),
            };
            (check, check)
        }
    };
    DirectoryCheck {
        path: path.to_string_lossy().into_owned(),
        read,
        write,
    }
}

fn check_write(path: &Path) -> CheckStatus {
    // Normal atomic saves create a temporary directory on the same mount.
    let probe = match tempfile::Builder::new()
        .prefix(".noto-storage-check-")
        .tempdir_in(path)
    {
        Ok(probe) => probe,
        Err(error) => return CheckStatus::from_error(error),
    };
    let written = fs::File::create_new(probe.path().join("probe")).and_then(|mut file| {
        file.write_all(b"Noto")?;
        file.sync_all()
    });
    let cleanup = probe.close();
    match (written, cleanup) {
        (_, Err(_)) => CheckStatus::CleanupFailed,
        (Err(error), Ok(())) => CheckStatus::from_error(error),
        (Ok(()), Ok(())) => CheckStatus::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_lists_directories_cleans_its_files_and_distinguishes_invalid_paths() {
        let vault = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let note = vault.path().join("笔记.md");
        fs::write(&note, "原文").unwrap();
        let report = StorageDiagnostics::probe(Some(vault.path()), data.path());
        let vault_probe = report.vault.unwrap();
        assert_eq!(vault_probe.read, CheckStatus::Ok);
        assert_eq!(vault_probe.write, CheckStatus::Ok);
        assert_eq!(report.data.write, CheckStatus::Ok);
        assert_eq!(fs::read_to_string(note).unwrap(), "原文");
        assert_eq!(fs::read_dir(vault.path()).unwrap().count(), 1);
        assert_eq!(fs::read_dir(data.path()).unwrap().count(), 0);

        let absent = data.path().join("不存在");
        let report = StorageDiagnostics::probe(None, &absent);
        assert!(report.vault.is_none());
        assert_eq!(report.data.read, CheckStatus::Missing);
        assert_eq!(report.data.write, CheckStatus::Missing);
        assert!(!absent.exists());

        let file = data.path().join("文件");
        fs::write(&file, "内容").unwrap();
        assert_eq!(
            StorageDiagnostics::probe(None, &file).data.write,
            CheckStatus::NotDirectory
        );
    }
}
