use crate::{
    blocking, error::ApiError, jobs::ensure_parent, read_json, routes::PathQuery, valid_id,
    write_json, Server,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    path: String,
    deleted_at: u64,
    is_directory: bool,
    status: String,
}
pub async fn remove(
    State(s): State<Arc<Server>>,
    Query(q): Query<PathQuery>,
) -> Result<StatusCode, ApiError> {
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        s.check(&q.path)?;
        let path = s.vault.item_path(&q.path)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut item = Item {
            id: id.clone(),
            path: q.path.clone(),
            deleted_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            is_directory: path.is_dir(),
            status: "pending".into(),
        };
        let metadata = s.data.join("trash").join(format!("{id}.json"));
        write_json(&metadata, &item)?;
        match s.vault.create_directory(".noto-trash") {
            Ok(()) => (),
            Err(noto_core::VaultError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                ()
            }
            Err(e) => return Err(e.into()),
        }
        // Hidden trash lives on the same mounted filesystem as the source.
        s.vault.move_item(&q.path, &format!(".noto-trash/{id}"))?;
        item.status = "deleted".into();
        write_json(&metadata, &item)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
pub async fn list(State(s): State<Arc<Server>>) -> Result<Json<Vec<Item>>, ApiError> {
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        let mut result = vec![];
        for entry in fs::read_dir(s.data.join("trash"))? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                let mut item: Item = read_json(&path)?;
                if s.vault
                    .item_path(&format!(".noto-trash/{}", item.id))
                    .is_ok()
                {
                    item.status = "deleted".into();
                    result.push(item);
                }
            }
        }
        result.sort_by_key(|i| std::cmp::Reverse(i.deleted_at));
        Ok(Json(result))
    })
    .await
}
pub async fn restore(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    valid_id(&id)?;
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        let metadata = s.data.join("trash").join(format!("{id}.json"));
        let mut item: Item = read_json(&metadata)?;
        s.check(&item.path)?;
        if item.id != id {
            return Err(ApiError::invalid());
        }
        ensure_parent(&s, &item.path)?;
        s.vault
            .move_item(&format!(".noto-trash/{id}"), &item.path)?;
        item.status = "restored".into();
        write_json(&metadata, &item)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
