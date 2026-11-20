use crate::{blocking, error::ApiError, Server};
use axum::{
    extract::{Multipart, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use noto_core::{Note, VaultEntry, HistoryEntry, HistorySnapshot};
use serde::Deserialize;
use std::{fs, io::{Read, Write}, sync::Arc};

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

pub async fn storage_diagnostics(
    State(s): State<Arc<Server>>,
) -> Result<Json<noto_core::StorageDiagnostics>, ApiError> {
    blocking(move || {
        Ok(Json(noto_core::StorageDiagnostics::probe(Some(s.vault.root()), &s.data)))
    })
    .await
}

pub async fn search_text(State(s): State<Arc<Server>>, Query(q): Query<PathQuery>) -> Result<Json<String>, ApiError> {
    blocking(move || {
        s.check(&q.path)?;
        Ok(Json(s.vault.read_search_text(&q.path)?))
    }).await
}

pub async fn export_vault(State(s): State<Arc<Server>>) -> Result<Response, ApiError> {
    use std::io::{Seek, SeekFrom};
    let (file, length) = blocking(move || {
        let mut file = tempfile::tempfile_in(&s.data)?;
        s.vault.export_zip(&mut file)?;
        let length = file.seek(SeekFrom::End(0))?;
        file.rewind()?;
        Ok((file, length))
    }).await?;
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=\"noto-vault.zip\"")
        .header(header::CONTENT_LENGTH, length)
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| ApiError::internal())
}
pub async fn webdav_test(Json(config):Json<noto_core::webdav::WebDavConfig>)->Result<StatusCode,ApiError>{
    blocking(move||noto_core::webdav::test_connection(config).map(|_|StatusCode::NO_CONTENT).map_err(|m|ApiError::new(StatusCode::BAD_REQUEST,"webdav",&m))).await
}
pub async fn webdav_sync(State(s):State<Arc<Server>>,Json(input):Json<noto_core::webdav::WebDavSync>)->Result<Json<noto_core::webdav::WebDavReport>,ApiError>{
    blocking(move||s.vault.sync_webdav(input).map(Json).map_err(|m|ApiError::new(StatusCode::BAD_REQUEST,"webdav",&m))).await
}
#[derive(Deserialize)]
pub struct HistoryQuery { path: String, id: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCheckpoint { path: String, content: String, expected_version: String }
pub async fn file_history(State(s): State<Arc<Server>>, Query(q): Query<PathQuery>) -> Result<Json<Vec<HistoryEntry>>, ApiError> {
    blocking(move || { s.check(&q.path)?; Ok(Json(s.vault.file_history(&q.path)?)) }).await
}
pub async fn read_history(State(s): State<Arc<Server>>, Query(q): Query<HistoryQuery>) -> Result<Json<HistorySnapshot>, ApiError> {
    blocking(move || { s.check(&q.path)?; Ok(Json(s.vault.read_history(&q.path, &q.id)?)) }).await
}
pub async fn checkpoint_history(State(s): State<Arc<Server>>, Json(b): Json<HistoryCheckpoint>) -> Result<StatusCode, ApiError> {
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        s.check(&b.path)?; s.vault.checkpoint_history(&b.path, &b.content, &b.expected_version)?;
        Ok(StatusCode::NO_CONTENT)
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteActivityRequest {
    day_starts: Vec<u64>,
}

pub async fn note_activity(State(s): State<Arc<Server>>, Json(request): Json<NoteActivityRequest>) -> Result<Json<Vec<noto_core::NoteActivityDay>>, ApiError> {
    blocking(move || Ok(Json(s.vault.note_activity(&request.day_starts)?))).await
}
#[derive(Deserialize)]
pub struct AttachmentQuery {
    note: String,
    link: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    content: String,
    expected_version: String,
}
#[derive(Deserialize)]
pub struct Create {
    path: String,
    #[serde(default)]
    content: String,
}
#[derive(Deserialize)]
pub struct Snapshot {
    notes: Vec<crate::jobs::Check>,
}
pub async fn snapshot(
    State(s): State<Arc<Server>>,
    Json(b): Json<Snapshot>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if b.notes.len() > 20000 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "too_large",
            "单次索引最多读取 20000 篇笔记",
        ));
    }
    blocking(move || {
        let mut notes = vec![];
        let mut unchanged = vec![];
        let mut errors = vec![];
        for check in b.notes {
            match s
                .check(&check.path)
                .and_then(|_| s.vault.read_note(&check.path).map_err(ApiError::from))
            {
                Ok(note) if note.version == check.version => unchanged.push(check.path),
                Ok(note) => notes.push(note),
                Err(error) => {
                    errors.push(serde_json::json!({"path":check.path,"error":error.message}))
                }
            }
        }
        Ok(Json(
            serde_json::json!({"notes":notes,"unchanged":unchanged,"errors":errors}),
        ))
    })
    .await
}

pub async fn entries(State(s): State<Arc<Server>>) -> Result<Json<Vec<VaultEntry>>, ApiError> {
    blocking(move || Ok(Json(s.vault.list()?))).await
}
pub async fn read_note(
    State(s): State<Arc<Server>>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Note>, ApiError> {
    blocking(move || {
        s.check(&q.path)?;
        Ok(Json(s.vault.read_note(&q.path)?))
    })
    .await
}
pub async fn save_note(
    State(s): State<Arc<Server>>,
    Query(q): Query<PathQuery>,
    Json(b): Json<Save>,
) -> Result<Json<Note>, ApiError> {
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        s.check(&q.path)?;
        Ok(Json(s.vault.save_note(
            &q.path,
            &b.content,
            &b.expected_version,
        )?))
    })
    .await
}
pub async fn create_note(
    State(s): State<Arc<Server>>,
    Json(b): Json<Create>,
) -> Result<Json<Note>, ApiError> {
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        s.check(&b.path)?;
        Ok(Json(s.vault.create_note(&b.path, &b.content)?))
    })
    .await
}
pub async fn create_directory(
    State(s): State<Arc<Server>>,
    Json(b): Json<PathQuery>,
) -> Result<StatusCode, ApiError> {
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        s.check(&b.path)?;
        s.vault.create_directory(&b.path)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
fn attachment(s: &Server, q: &AttachmentQuery) -> Result<std::path::PathBuf, ApiError> {
    s.check(&q.note)?;
    if q.link.contains('\\') {
        return Err(ApiError::invalid());
    }
    let path = s.vault.attachment_path(&q.note, &q.link)?;
    let relative = path
        .strip_prefix(s.vault.root())
        .map_err(|_| ApiError::invalid())?
        .to_string_lossy()
        .replace('\\', "/");
    s.check(&relative)?;
    Ok(path)
}
pub async fn pdf(
    State(s): State<Arc<Server>>,
    Query(q): Query<PathQuery>,
) -> Result<Json<noto_core::PdfDocument>, ApiError> {
    blocking(move || {
        s.check(&q.path)?;
        Ok(Json(s.vault.read_pdf(&q.path)?))
    }).await
}

#[derive(Deserialize)]
pub struct PdfVersionQuery {
    version: String,
}

pub async fn pdf_annotations(
    State(s): State<Arc<Server>>,
    Query(q): Query<PdfVersionQuery>,
) -> Result<Json<noto_core::PdfAnnotations>, ApiError> {
    blocking(move || Ok(Json(s.vault.read_pdf_annotations(&q.version)?))).await
}

pub async fn save_pdf_annotations(
    State(s): State<Arc<Server>>,
    Query(q): Query<PathQuery>,
    Json(update): Json<noto_core::PdfAnnotationUpdate>,
) -> Result<Json<noto_core::PdfAnnotations>, ApiError> {
    blocking(move || {
        s.check(&q.path)?;
        Ok(Json(s.vault.save_pdf_annotations(&q.path, update)?))
    }).await
}

pub async fn image(
    State(s): State<Arc<Server>>,
    Query(q): Query<AttachmentQuery>,
) -> Result<Json<String>, ApiError> {
    blocking(move || {
        let path = attachment(&s, &q)?;
        let mime = mime_guess::from_path(&path).first_or_octet_stream();
        if !matches!(
            mime.essence_str(),
            "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp"
                | "image/avif"
                | "image/bmp"
                | "image/svg+xml"
        ) {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "unsupported",
                "该附件不是可预览的图片",
            ));
        }
        if fs::metadata(&path)?.len() > 32 * 1024 * 1024 {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "too_large",
                "图片超过 32 MB，请下载查看",
            ));
        }
        let mut bytes=Vec::new();
        fs::File::open(path)?.take(32*1024*1024+1).read_to_end(&mut bytes)?;
        if bytes.len()>32*1024*1024 {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE,"too_large","图片超过 32 MiB，请下载查看"));
        }
        Ok(Json(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    })
    .await
}
pub async fn download(
    State(s): State<Arc<Server>>,
    Query(q): Query<AttachmentQuery>,
) -> Result<Response, ApiError> {
    let path = blocking(move || attachment(&s, &q)).await?;
    // ServeFile streams without buffering arbitrarily large local files. Always
    // download: HTML/SVG attachments must never execute under the app's origin.
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let encoded: String = name
        .as_bytes()
        .iter()
        .map(|b| format!("%{b:02X}"))
        .collect();
    let request = axum::http::Request::builder()
        .uri("/")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = tower_http::services::ServeFile::new(path)
        .try_call(request)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut response = response.into_response();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=attachment; filename*=UTF-8''{encoded}"
        ))
        .map_err(|_| ApiError::invalid())?,
    );
    Ok(response)
}
pub async fn upload(
    State(s): State<Arc<Server>>,
    Query(q): Query<PathQuery>,
    mut multipart: Multipart,
) -> Result<Json<String>, ApiError> {
    let field = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::invalid())?
        .ok_or_else(ApiError::invalid)?;
    let name = field.file_name().ok_or_else(ApiError::invalid)?.to_owned();
    if name.starts_with('.')
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
        || name.is_empty()
    {
        return Err(ApiError::invalid());
    }
    let bytes = field.bytes().await.map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "附件上传失败，单个附件上限为 64 MB",
        )
    })?;
    blocking(move || {
        let _guard = s.writes.lock().map_err(|_| ApiError::internal())?;
        s.check(&q.path)?;
        let dir = s
            .data
            .join("uploads")
            .join(uuid::Uuid::new_v4().simple().to_string());
        fs::create_dir(&dir)?;
        let temp = dir.join(name);
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&bytes)?;
            s.vault
                .import_attachment(&q.path, &temp)
                .map(Json)
                .map_err(ApiError::from)
        })();
        let _ = fs::remove_file(&temp);
        let _ = fs::remove_dir(&dir);
        result
    })
    .await
}
