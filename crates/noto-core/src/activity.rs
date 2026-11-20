use crate::{is_markdown_path, Vault, VaultError};
use serde::Serialize;
use std::{
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

// Keep older activity files outside the public workspace paths.
pub(crate) const LEGACY_ACTIVITY_DIR: &str = ".noto-activity";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NoteActivityDay {
    pub created: usize,
    pub edited: usize,
}

fn day_bucket(day_starts: &[u64], time: io::Result<SystemTime>) -> Option<usize> {
    let elapsed = time.ok()?.duration_since(UNIX_EPOCH).ok()?;
    let millis = u64::try_from(elapsed.as_millis()).ok()?;
    let index = day_starts
        .partition_point(|start| *start <= millis)
        .checked_sub(1)?;
    (index + 1 < day_starts.len()).then_some(index)
}

fn count_note(days: &mut [NoteActivityDay], created: Option<usize>, modified: Option<usize>) {
    if let Some(index) = created {
        days[index].created += 1;
    }
    if let Some(index) = modified.filter(|index| Some(*index) != created) {
        days[index].edited += 1;
    }
}

impl Vault {
    /// Count current Markdown file timestamps within the supplied local-day boundaries.
    pub fn note_activity(&self, day_starts: &[u64]) -> Result<Vec<NoteActivityDay>, VaultError> {
        if !(2..=366).contains(&day_starts.len())
            || !day_starts.windows(2).all(|days| days[0] < days[1])
            || day_starts[day_starts.len() - 1] - day_starts[0] > 366 * DAY_MS
        {
            return Err(VaultError::InvalidPath);
        }
        let mut days = vec![NoteActivityDay::default(); day_starts.len() - 1];
        let mut entries = self.list()?;
        while let Some(entry) = entries.pop() {
            if entry.issue.is_some() {
                continue;
            }
            if entry.is_directory {
                entries.extend(entry.children);
                continue;
            }
            if !is_markdown_path(Path::new(&entry.path)) {
                continue;
            }
            let metadata = match self
                .item_path(&entry.path)
                .and_then(|path| fs::symlink_metadata(path).map_err(VaultError::from))
            {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) | Err(VaultError::InvalidPath) => continue,
                Err(VaultError::Io(error)) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            count_note(
                &mut days,
                day_bucket(day_starts, metadata.created()),
                day_bucket(day_starts, metadata.modified()),
            );
        }
        Ok(days)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::FileTimes, time::Duration};

    #[test]
    fn timestamp_boundaries_and_same_day_creation_take_precedence() {
        let boundaries = [DAY_MS, 2 * DAY_MS, 3 * DAY_MS];
        let bucket = |ms| day_bucket(&boundaries, Ok(UNIX_EPOCH + Duration::from_millis(ms)));
        assert_eq!(bucket(DAY_MS - 1), None);
        assert_eq!(bucket(DAY_MS), Some(0));
        assert_eq!(bucket(2 * DAY_MS - 1), Some(0));
        assert_eq!(bucket(2 * DAY_MS), Some(1));
        assert_eq!(bucket(3 * DAY_MS), None);
        assert_eq!(
            day_bucket(&boundaries, Err(io::ErrorKind::Unsupported.into())),
            None
        );

        let mut days = vec![NoteActivityDay::default(); 2];
        count_note(&mut days, Some(0), Some(0));
        count_note(&mut days, Some(0), Some(1));
        count_note(&mut days, None, Some(1));
        assert_eq!(
            days,
            [
                NoteActivityDay {
                    created: 2,
                    edited: 0
                },
                NoteActivityDay {
                    created: 0,
                    edited: 2
                }
            ]
        );
    }

    #[test]
    fn reads_disk_metadata_and_leaves_old_activity_files_alone() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let vault = Vault::open(root).unwrap();
        let created = vault.create_note("新建.md", "旧内容").unwrap();
        vault
            .save_note("新建.md", "新内容", &created.version)
            .unwrap();
        assert!(!root.join(LEGACY_ACTIVITY_DIR).exists());
        let legacy = root.join(LEGACY_ACTIVITY_DIR);
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("old.jsonl"), "old log").unwrap();

        fs::create_dir(root.join("项目")).unwrap();
        let set_modified = |relative: &str| {
            let path = root.join(relative);
            let file = fs::File::create(path).unwrap();
            file.set_times(
                FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(DAY_MS + 1)),
            )
            .unwrap();
        };
        set_modified("项目/既有.markdown");
        set_modified(".hidden.md");
        set_modified(".noto-activity/ignored.md");
        set_modified("画布.canvas");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("项目/既有.markdown"), root.join("alias.md")).unwrap();

        let range = [DAY_MS, 2 * DAY_MS];
        assert_eq!(
            vault.note_activity(&range).unwrap(),
            [NoteActivityDay {
                created: 0,
                edited: 1
            }]
        );
        fs::remove_file(root.join("项目/既有.markdown")).unwrap();
        assert_eq!(
            vault.note_activity(&range).unwrap(),
            [NoteActivityDay::default()]
        );
        assert!(vault.note_activity(&[DAY_MS, DAY_MS]).is_err());
        assert!(vault.item_path(".noto-activity/old.jsonl").is_err());
        assert_eq!(
            fs::read_to_string(legacy.join("old.jsonl")).unwrap(),
            "old log"
        );
    }
}
