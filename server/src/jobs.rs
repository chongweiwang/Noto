use crate::{blocking, error::ApiError, read_json, valid_id, write_json, Server};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use noto_core::Note;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, sync::Arc};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Move {
    pub from: String,
    pub to: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub path: String,
    pub target: String,
    pub content: String,
    pub expected_version: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Check {
    pub path: String,
    pub version: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Plan {
    pub moves: Vec<Move>,
    pub edits: Vec<Edit>,
    pub checks: Vec<Check>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub status: String,
    pub completed_moves: Vec<Move>,
    pub notes: Vec<Note>,
    pub backup: String,
    pub message: Option<String>,
    pub pending_move: Option<Move>,
    plan: Plan,
    fingerprint: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    id: String,
    status: String,
    completed_moves: Vec<Move>,
    notes: Vec<Note>,
    backup: String,
    message: Option<String>,
    pending_move: Option<Move>,
}
impl From<Operation> for View {
    fn from(o: Operation) -> Self {
        Self {
            id: o.id,
            status: o.status,
            completed_moves: o.completed_moves,
            notes: o.notes,
            backup: o.backup,
            message: o.message,
            pending_move: o.pending_move,
        }
    }
}
fn record(s: &Server, op: &Operation) -> Result<(), ApiError> {
    let _guard = s.jobs.lock().map_err(|_| ApiError::internal())?;
    write_json(
        &s.data.join("operations").join(format!("{}.json", op.id)),
        op,
    )
}
pub fn recover_interrupted(s: &Server) -> Result<(), ApiError> {
    for entry in fs::read_dir(s.data.join("operations"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let mut op: Operation = read_json(&path)?;
            if matches!(op.status.as_str(), "running" | "queued") {
                op.status = "interrupted".into();
                op.message = Some("服务在目录操作期间停止；请检查备份及已完成步骤，不会自动重复移动。待确认步骤需核对实际文件位置。".into());
                record(s, &op)?;
            }
        }
    }
    Ok(())
}
pub async fn get(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
) -> Result<Json<View>, ApiError> {
    valid_id(&id)?;
    blocking(move || {
        let _guard = s.jobs.lock().map_err(|_| ApiError::internal())?;
        read_json::<Operation>(&s.data.join("operations").join(format!("{id}.json")))
            .map(|op| Json(op.into()))
    })
    .await
}
pub async fn submit(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(plan): Json<Plan>,
) -> Result<(StatusCode, Json<View>), ApiError> {
    valid_id(&id)?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&plan).map_err(|_| ApiError::invalid())?)
    );
    let copy = s.clone();
    let (op, fresh) = blocking(move || {
        let _guard = copy.jobs.lock().map_err(|_| ApiError::internal())?;
        let path = copy.data.join("operations").join(format!("{id}.json"));
        if path.exists() {
            let op: Operation = read_json(&path)?;
            if op.fingerprint != fingerprint {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "operation_id",
                    "该操作标识已用于另一个请求",
                ));
            }
            return Ok((op, false));
        }
        validate_plan(&copy, &plan)?;
        let op = Operation {
            backup: format!("backups/{id}"),
            id,
            status: "queued".into(),
            completed_moves: vec![],
            notes: vec![],
            message: None,
            pending_move: None,
            plan,
            fingerprint,
        };
        write_json(&path, &op)?;
        Ok((op, true))
    })
    .await?;
    if fresh {
        let operation = op.clone();
        tokio::task::spawn_blocking(move || execute(&s, operation));
    }
    Ok((StatusCode::ACCEPTED, Json(op.into())))
}
fn remap(path: &str, moves: &[Move]) -> String {
    moves
        .iter()
        .find(|m| path == m.from || path.starts_with(&format!("{}/", m.from)))
        .map_or_else(
            || path.to_owned(),
            |m| format!("{}{}", m.to, &path[m.from.len()..]),
        )
}
fn validate_plan(s: &Server, plan: &Plan) -> Result<(), ApiError> {
    if plan.moves.is_empty() || plan.moves.len() > 1000 || plan.edits.len() > 20000 {
        return Err(ApiError::invalid());
    }
    let overlaps = |a: &str, b: &str| {
        a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
    };
    for (i, m) in plan.moves.iter().enumerate() {
        s.check(&m.from)?;
        s.check(&m.to)?;
        if overlaps(&m.from, &m.to)
            || plan.moves.iter().enumerate().any(|(j, other)| {
                i != j
                    && (overlaps(&m.from, &other.from)
                        || overlaps(&m.to, &other.to)
                        || overlaps(&m.to, &other.from))
            })
        {
            return Err(ApiError::invalid());
        }
    }
    let mut paths = std::collections::HashSet::new();
    for edit in &plan.edits {
        s.check(&edit.path)?;
        s.check(&edit.target)?;
        if !paths.insert(edit.path.clone()) || remap(&edit.path, &plan.moves) != edit.target {
            return Err(ApiError::invalid());
        }
    }
    for check in &plan.checks {
        s.check(&check.path)?;
    }
    Ok(())
}
pub(crate) fn ensure_parent(s: &Server, path: &str) -> Result<(), ApiError> {
    let parts: Vec<_> = path.split('/').collect();
    for count in 1..parts.len() {
        let parent = parts[..count].join("/");
        s.check(&parent)?;
        match s.vault.item_path(&parent) {
            Ok(path) if path.is_dir() => (),
            Ok(_) => return Err(ApiError::invalid()),
            Err(noto_core::VaultError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                s.vault.create_directory(&parent)?
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn run(s: &Server, op: &mut Operation) -> Result<(), ApiError> {
    validate_plan(s, &op.plan)?;
    // All writes through this server share this lock; external sync tools remain
    // independent, so each protected save still checks the bytes on disk.
    let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
    for check in &op.plan.checks {
        if s.vault.read_note(&check.path)?.version != check.version {
            return Err(noto_core::VaultError::Conflict.into());
        }
    }
    for m in &op.plan.moves {
        s.vault.item_path(&m.from)?;
        if s.vault.root().join(&m.to).try_exists()? {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "already_exists",
                "移动目标已存在，不会覆盖",
            ));
        }
    }
    let backup = s.data.join(&op.backup);
    fs::create_dir(&backup)?;
    for edit in &op.plan.edits {
        if s.vault.read_note(&edit.path)?.version != edit.expected_version {
            return Err(noto_core::VaultError::Conflict.into());
        }
        let target = backup.join(&edit.path);
        fs::create_dir_all(target.parent().ok_or_else(ApiError::invalid)?)?;
        fs::copy(s.vault.item_path(&edit.path)?, &target)?;
    }
    write_json(&backup.join("plan.json"), &op.plan)?;
    op.status = "running".into();
    record(s, op)?;
    for m in op.plan.moves.clone() {
        ensure_parent(s, &m.to)?;
        op.pending_move = Some(m.clone());
        record(s, op)?;
        s.vault.move_item(&m.from, &m.to)?;
        op.completed_moves.push(m);
        op.pending_move = None;
        record(s, op)?;
    }
    for edit in &op.plan.edits {
        let disk = s.vault.read_note(&edit.target)?;
        if disk.version != edit.expected_version {
            return Err(noto_core::VaultError::Conflict.into());
        }
        let saved = if disk.content == edit.content {
            disk
        } else {
            s.vault
                .save_note(&edit.target, &edit.content, &disk.version)?
        };
        op.notes.push(saved);
        record(s, op)?;
    }
    op.status = "completed".into();
    record(s, op)?;
    Ok(())
}
fn execute(s: &Server, mut op: Operation) {
    if let Err(error) = run(s, &mut op) {
        op.status = "failed".into();
        op.message = Some(error.message);
        if let Err(error) = record(s, &op) {
            eprintln!("Noto operation progress could not be saved: {error:?}");
        }
    }
}
