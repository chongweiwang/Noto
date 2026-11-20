use atomicwrites::{AllowOverwrite, AtomicFile};
use noto_core::Vault;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub path: String,
    pub content: String,
    pub base_version: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    last_vault: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub vault: Option<String>,
    pub error: Option<String>,
}

pub struct DesktopState {
    data_dir: PathBuf,
    vault: Mutex<Option<Arc<Vault>>>,
    startup_error: Mutex<Option<String>>,
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("应用数据目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| {
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .map_err(|e| e.to_string())
}

impl DesktopState {
    pub fn new(data_dir: PathBuf) -> Self {
        let mut vault = None;
        let mut startup_error = None;
        let config_path = data_dir.join("settings.json");
        match fs::read(&config_path) {
            Ok(bytes) => match serde_json::from_slice::<Config>(&bytes) {
                Ok(config) => {
                    if let Some(path) = config.last_vault {
                        match Vault::open(&path) {
                            Ok(opened) => vault = Some(Arc::new(opened)),
                            Err(e) => {
                                startup_error =
                                    Some(format!("无法重新打开上次的知识库 {path}：{e}"))
                            }
                        }
                    }
                }
                Err(e) => startup_error = Some(format!("无法读取应用设置：{e}")),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => startup_error = Some(format!("无法读取应用设置：{e}")),
        }
        Self {
            data_dir,
            vault: Mutex::new(vault),
            startup_error: Mutex::new(startup_error),
        }
    }

    pub fn vault(&self) -> Result<Arc<Vault>, String> {
        self.vault
            .lock()
            .map_err(|_| "知识库状态异常".to_string())?
            .clone()
            .ok_or_else(|| "请先选择知识库".to_string())
    }

    pub fn status(&self) -> Result<Status, String> {
        let vault = self
            .vault
            .lock()
            .map_err(|_| "知识库状态异常")?
            .as_ref()
            .map(|v| v.root().to_string_lossy().into_owned());
        let error = self
            .startup_error
            .lock()
            .map_err(|_| "应用状态异常")?
            .clone();
        Ok(Status { vault, error })
    }

    pub fn storage_paths(&self) -> Result<(Option<PathBuf>, PathBuf), String> {
        let vault = self
            .vault
            .lock()
            .map_err(|_| "知识库状态异常")?
            .as_ref()
            .map(|vault| vault.root().to_path_buf());
        Ok((vault, self.data_dir.clone()))
    }

    pub fn select_vault(&self, path: &str) -> Result<Status, String> {
        let vault = Arc::new(Vault::open(path).map_err(|e| e.to_string())?);
        let root = vault.root().to_string_lossy().into_owned();
        write_json(
            &self.data_dir.join("settings.json"),
            &Config {
                last_vault: Some(root),
            },
        )
        .map_err(|e| format!("无法保存知识库设置：{e}"))?;
        *self.vault.lock().map_err(|_| "知识库状态异常")? = Some(vault);
        *self.startup_error.lock().map_err(|_| "应用状态异常")? = None;
        self.status()
    }

    fn draft_dir(&self) -> Result<PathBuf, String> {
        let vault = self.vault()?;
        Ok(self
            .data_dir
            .join("drafts")
            .join(hash(&vault.root().to_string_lossy())))
    }

    fn draft_file(&self, path: &str) -> Result<PathBuf, String> {
        let relative = Path::new(path);
        if path.is_empty()
            || !relative
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err("草稿路径无效".into());
        }
        Ok(self.draft_dir()?.join(format!("{}.json", hash(path))))
    }

    pub fn write_draft(&self, draft: &Draft) -> Result<(), String> {
        write_json(&self.draft_file(&draft.path)?, draft)
            .map_err(|e| format!("无法保存恢复草稿：{e}"))
    }

    pub fn remove_draft(&self, path: &str) -> Result<(), String> {
        match fs::remove_file(self.draft_file(path)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("无法删除恢复草稿：{e}")),
        }
    }

    pub fn drafts(&self) -> Result<Vec<Draft>, String> {
        let dir = self.draft_dir()?;
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("无法读取恢复草稿：{e}")),
        };
        let mut drafts = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("无法读取恢复草稿：{e}"))?;
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let bytes = fs::read(entry.path()).map_err(|e| format!("无法读取恢复草稿：{e}"))?;
            let draft: Draft = serde_json::from_slice(&bytes)
                .map_err(|e| format!("恢复草稿损坏（{}）：{e}", entry.path().display()))?;
            drafts.push(draft);
        }
        drafts.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(drafts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_vault_and_drafts_without_putting_them_in_vault() {
        let data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let state = DesktopState::new(data.path().to_path_buf());
        state.select_vault(vault.path().to_str().unwrap()).unwrap();
        state
            .write_draft(&Draft {
                path: "笔记.md".into(),
                content: "未保存".into(),
                base_version: "v1".into(),
            })
            .unwrap();
        drop(state);
        let reopened = DesktopState::new(data.path().to_path_buf());
        assert!(reopened.status().unwrap().vault.is_some());
        assert_eq!(reopened.drafts().unwrap()[0].content, "未保存");
        assert_eq!(fs::read_dir(vault.path()).unwrap().count(), 0);
        reopened.remove_draft("笔记.md").unwrap();
        assert!(reopened.drafts().unwrap().is_empty());
    }

    #[test]
    fn reports_draft_storage_failure() {
        let data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let state = DesktopState::new(data.path().to_path_buf());
        state.select_vault(vault.path().to_str().unwrap()).unwrap();
        fs::write(data.path().join("drafts"), "blocking file").unwrap();
        let result = state.write_draft(&Draft {
            path: "笔记.md".into(),
            content: "未保存".into(),
            base_version: "v1".into(),
        });
        assert!(result.unwrap_err().contains("无法保存恢复草稿"));
        assert_eq!(
            fs::read_to_string(data.path().join("drafts")).unwrap(),
            "blocking file"
        );
    }

    #[test]
    fn keeps_drafts_isolated_and_reports_corruption_without_removing_it() {
        let data = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = DesktopState::new(data.path().to_path_buf());
        state.select_vault(first.path().to_str().unwrap()).unwrap();
        let draft = Draft {
            path: "目录/笔记.md".into(),
            content: "第一份草稿".into(),
            base_version: "v1".into(),
        };
        state.write_draft(&draft).unwrap();
        state.select_vault(second.path().to_str().unwrap()).unwrap();
        assert!(state.drafts().unwrap().is_empty());
        state.select_vault(first.path().to_str().unwrap()).unwrap();
        assert_eq!(state.drafts().unwrap()[0].content, draft.content);
        let path = state.draft_file(&draft.path).unwrap();
        fs::write(&path, "corrupted json").unwrap();
        assert!(state.drafts().err().unwrap().contains("恢复草稿损坏"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "corrupted json");
        assert!(state
            .write_draft(&Draft {
                path: "../outside.md".into(),
                ..draft
            })
            .is_err());
    }
}
