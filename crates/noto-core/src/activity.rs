use crate::{is_markdown_path, operations::validate_relative, Vault, VaultError};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::Entry, HashMap},
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const ACTIVITY_DIR: &str = ".noto-activity";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const RETAIN_DAYS: u64 = 370;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActivityKind {
    Created,
    Edited,
}

#[derive(Deserialize, Serialize)]
struct Record {
    at: u64,
    path: String,
    kind: ActivityKind,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct NoteActivityDay {
    pub created: usize,
    pub edited: usize,
}

fn log_path(directory: &Path, day: u64) -> PathBuf {
    directory.join(format!("{day}.jsonl"))
}

fn regular_log(path: &Path) -> Result<bool, VaultError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(VaultError::InvalidPath),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn visible_markdown(path: &str) -> bool {
    !path.split('/').any(|part| part.starts_with('.'))
        && validate_relative(path).is_ok_and(is_markdown_path)
}

impl Vault {
    fn activity_directory(&self, create: bool) -> Result<Option<PathBuf>, VaultError> {
        let directory = self.root().join(ACTIVITY_DIR);
        if create {
            match fs::create_dir(&directory) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.into()),
            }
        }
        match fs::symlink_metadata(&directory) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(Some(directory)),
            Ok(_) => Err(VaultError::InvalidPath),
            Err(error) if !create && error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    // The caller already holds the vault write lock and has committed the note.
    pub(crate) fn record_note_activity(&self, relative: &str, kind: ActivityKind) {
        if !visible_markdown(relative) {
            return;
        }
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if let Err(error) = self.append_note_activity(Record {
            at,
            path: relative.to_owned(),
            kind,
        }) {
            eprintln!("Noto note activity write failed: {error}");
        }
    }

    fn append_note_activity(&self, record: Record) -> Result<(), VaultError> {
        let directory = self
            .activity_directory(true)?
            .ok_or(VaultError::InvalidPath)?;
        let day = record.at / DAY_MS;
        let path = log_path(&directory, day);
        let existing = regular_log(&path)?;
        // A leading newline isolates an interrupted append from the next record.
        let mut line = vec![b'\n'];
        serde_json::to_writer(&mut line, &record).map_err(io::Error::other)?;
        line.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(&line)?;
        if !existing {
            prune(&directory, day.saturating_sub(RETAIN_DAYS));
        }
        Ok(())
    }

    /// Count distinct notes between successive UTC boundaries of local calendar days.
    pub fn note_activity(&self, day_starts: &[u64]) -> Result<Vec<NoteActivityDay>, VaultError> {
        if !(2..=366).contains(&day_starts.len())
            || !day_starts.windows(2).all(|days| days[0] < days[1])
            || day_starts[day_starts.len() - 1] - day_starts[0] > 366 * DAY_MS
        {
            return Err(VaultError::InvalidPath);
        }
        let _guard = self.writes.lock().map_err(|_| VaultError::LockPoisoned)?;
        let mut buckets = vec![HashMap::new(); day_starts.len() - 1];
        let Some(directory) = self.activity_directory(false)? else {
            return Ok(buckets.iter().map(|_| NoteActivityDay::default()).collect());
        };
        let from = day_starts[0];
        let until = day_starts[day_starts.len() - 1];
        for day in from / DAY_MS..=(until - 1) / DAY_MS {
            let path = log_path(&directory, day);
            if !regular_log(&path)? {
                continue;
            }
            for line in BufReader::new(File::open(path)?).split(b'\n') {
                let Ok(record) = serde_json::from_slice::<Record>(&line?) else {
                    continue;
                };
                if record.at < from
                    || record.at >= until
                    || record.at / DAY_MS != day
                    || !visible_markdown(&record.path)
                {
                    continue;
                }
                let bucket = day_starts.partition_point(|&start| start <= record.at) - 1;
                match buckets[bucket].entry(record.path) {
                    Entry::Vacant(slot) => {
                        slot.insert(record.kind);
                    }
                    Entry::Occupied(mut slot) if matches!(record.kind, ActivityKind::Created) => {
                        slot.insert(record.kind);
                    }
                    Entry::Occupied(_) => (),
                }
            }
        }
        Ok(buckets
            .into_iter()
            .map(|bucket| {
                let created = bucket
                    .values()
                    .filter(|kind| matches!(kind, ActivityKind::Created))
                    .count();
                NoteActivityDay {
                    created,
                    edited: bucket.len() - created,
                }
            })
            .collect())
    }
}

fn prune(directory: &Path, before: u64) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(day) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".jsonl"))
            .and_then(|name| name.parse::<u64>().ok())
        else {
            continue;
        };
        if day < before
            && entry.path() == log_path(directory, day)
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_count_distinct_markdown_notes_after_success() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("现有.md"), "原文").unwrap();
        fs::write(directory.path().join("未改.md"), "未改").unwrap();
        let vault = Vault::open(directory.path()).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let range = [now - DAY_MS, now + DAY_MS];
        assert_eq!(
            vault.note_activity(&range).unwrap(),
            vec![NoteActivityDay::default()]
        );
        let created = vault.create_note("新建.markdown", "正文").unwrap();
        let saved = vault
            .save_note(&created.path, "新内容", &created.version)
            .unwrap();
        vault
            .save_note(&saved.path, "再次保存", &saved.version)
            .unwrap();
        let original = vault.read_note("现有.md").unwrap();
        assert!(vault.save_note(&original.path, "冲突", "错版").is_err());
        let edited = vault
            .save_note(&original.path, "修改", &original.version)
            .unwrap();
        vault
            .save_note(&edited.path, "继续修改", &edited.version)
            .unwrap();
        let unchanged = vault.read_note("未改.md").unwrap();
        vault
            .save_note(&unchanged.path, &unchanged.content, &unchanged.version)
            .unwrap();
        vault.create_note("看板.canvas", "{}").unwrap();

        let vault = Vault::open(directory.path()).unwrap();
        assert_eq!(
            vault.note_activity(&range).unwrap(),
            vec![NoteActivityDay {
                created: 1,
                edited: 1
            }]
        );
        assert!(vault.item_path(ACTIVITY_DIR).is_err());
        assert!(vault
            .list()
            .unwrap()
            .iter()
            .all(|entry| entry.name != ACTIVITY_DIR));
    }

    #[test]
    fn local_midnight_can_split_a_utc_log_and_corrupt_tail_does_not_hide_new_records() {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path()).unwrap();
        let midnight = 2 * DAY_MS - 8 * 60 * 60 * 1000;
        vault
            .append_note_activity(Record {
                at: midnight - 1,
                path: "项目.md".into(),
                kind: ActivityKind::Edited,
            })
            .unwrap();
        let path = log_path(&vault.root().join(ACTIVITY_DIR), midnight / DAY_MS);
        OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(b"{\"at\":")
            .unwrap();
        vault
            .append_note_activity(Record {
                at: midnight,
                path: "项目.md".into(),
                kind: ActivityKind::Edited,
            })
            .unwrap();
        vault
            .append_note_activity(Record {
                at: 2 * DAY_MS,
                path: "项目.md".into(),
                kind: ActivityKind::Edited,
            })
            .unwrap();
        assert_eq!(
            vault
                .note_activity(&[midnight - DAY_MS, midnight, midnight + DAY_MS])
                .unwrap(),
            vec![
                NoteActivityDay {
                    created: 0,
                    edited: 1
                },
                NoteActivityDay {
                    created: 0,
                    edited: 1
                },
            ]
        );
        assert!(vault.note_activity(&[midnight, midnight]).is_err());
    }
}
