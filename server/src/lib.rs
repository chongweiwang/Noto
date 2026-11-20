mod auth;
mod config;
mod error;
mod jobs;
mod routes;
mod trash;

use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
pub use config::Config;
use error::ApiError;
use noto_core::Vault;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tower_http::services::ServeDir;

#[derive(Serialize, Deserialize)]
struct Identity {
    server_id: String,
    vault_id: String,
    root: PathBuf,
    password_hash: String,
}
pub struct Server {
    vault: Vault,
    data: PathBuf,
    frontend: PathBuf,
    name: String,
    identity: Identity,
    auth: Mutex<auth::Auth>,
    writes: Mutex<()>,
    jobs: Mutex<()>,
    secure_cookie: bool,
    public_origin: Option<String>,
    local_origin: Option<String>,
}

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| ApiError::internal())?;
    atomicwrites::AtomicFile::new(path, atomicwrites::AllowOverwrite)
        .write(|file| file.write_all(&bytes))
        .map_err(|error| {
            eprintln!("Noto state write failed: {error}");
            ApiError::internal()
        })
}
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, ApiError> {
    serde_json::from_slice(&fs::read(path)?).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "state_corrupt",
            "服务状态文件损坏，请保留原文件并检查服务日志",
        )
    })
}
pub(crate) fn visible(path: &str) -> Result<(), ApiError> {
    if path.is_empty()
        || path.contains(['\\', ':', '\0'])
        || path
            .split('/')
            .any(|p| p.is_empty() || p.starts_with('.') || p.chars().any(char::is_control))
    {
        return Err(ApiError::invalid());
    }
    Ok(())
}
pub(crate) fn valid_id(id: &str) -> Result<(), ApiError> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::invalid());
    }
    Ok(())
}
impl Server {
    pub fn open(config: Config) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let vault = Vault::open(&config.vault)?;
        fs::create_dir_all(&config.data)?;
        let data = fs::canonicalize(&config.data)?;
        let frontend = fs::canonicalize(&config.frontend)?;
        if !frontend.join("index.html").is_file() {
            return Err("找不到静态网页 index.html，请先构建前端".into());
        }
        let roots = [vault.root(), data.as_path(), frontend.as_path()];
        for (i, root) in roots.iter().enumerate() {
            if roots
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && root.starts_with(other))
            {
                return Err("知识库、服务数据及静态资源必须使用互不包含的目录".into());
            }
        }
        let identity_file = data.join("identity.json");
        let identity: Identity = if identity_file.exists() {
            let mut value: Identity = read_json(&identity_file)?;
            argon2::PasswordHash::new(&value.password_hash)
                .map_err(|_| "访问口令状态损坏，请保留服务状态文件并检查配置")?;
            if value.root != vault.root() {
                return Err(
                    "服务数据已绑定另一个知识库，请为新知识库使用独立 NOTO_DATA_DIR".into(),
                );
            }
            if let Some(password) = &config.password {
                auth::validate_password(password, config.allow_short_password)?;
                use argon2::{Argon2, PasswordHash, PasswordVerifier};
                let same = PasswordHash::new(&value.password_hash)
                    .ok()
                    .is_some_and(|hash| {
                        Argon2::default()
                            .verify_password(password.as_bytes(), &hash)
                            .is_ok()
                    });
                if !same {
                    value.password_hash = auth::hash_password(password, config.allow_short_password)?;
                    write_json(&identity_file, &value)?;
                }
            }
            value
        } else {
            let password = config
                .password
                .as_deref()
                .ok_or("首次启动必须配置 NOTO_PASSWORD_FILE 或 NOTO_PASSWORD")?;
            let value = Identity {
                server_id: uuid::Uuid::new_v4().simple().to_string(),
                vault_id: uuid::Uuid::new_v4().simple().to_string(),
                root: vault.root().to_path_buf(),
                password_hash: auth::hash_password(password, config.allow_short_password)?,
            };
            write_json(&identity_file, &value)?;
            value
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&identity_file, fs::Permissions::from_mode(0o600))?;
        }
        for folder in ["operations", "backups", "uploads", "trash"] {
            fs::create_dir_all(data.join(folder))?;
        }
        let name = vault
            .root()
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .trim_start_matches('.')
            .to_owned();
        let state = Arc::new(Self {
            auth: Mutex::new(auth::Auth {
                hash: identity.password_hash.clone(),
                sessions: HashMap::new(),
                attempts: vec![],
            }),
            vault,
            data,
            frontend,
            name: if name.is_empty() {
                "知识库".into()
            } else {
                name
            },
            identity,
            writes: Mutex::new(()),
            jobs: Mutex::new(()),
            secure_cookie: config.secure_cookie,
            public_origin: config.public_origin,
            local_origin: config.local_origin,
        });
        jobs::recover_interrupted(&state)?;
        Ok(state)
    }
    fn check(&self, path: &str) -> Result<(), ApiError> {
        visible(path)?;
        // Also reject aliases to private state, even if a local tool created them.
        let mut parent = self.vault.root().to_path_buf();
        for part in path.split('/') {
            parent.push(part);
            if let Ok(meta) = fs::symlink_metadata(&parent) {
                if meta.file_type().is_symlink() {
                    return Err(ApiError::invalid());
                }
            }
        }
        Ok(())
    }
}
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| ApiError::internal())?
}
async fn response_headers(request: Request, next: Next) -> Response {
    let api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "same-origin".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    if api {
        headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    // The shared editor uses inline styles; scripts are restricted to this static build.
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'".parse().unwrap());
    response
}
pub fn app(state: Arc<Server>) -> Router {
    let api = Router::new()
        .route("/session", get(auth::session).delete(auth::logout))
        .route("/entries", get(routes::entries))
        .route("/storage-diagnostics", post(routes::storage_diagnostics))
        .route("/snapshot", post(routes::snapshot))
        .route("/history", get(routes::file_history))
        .route("/history/content", get(routes::read_history))
        .route("/history/checkpoint", post(routes::checkpoint_history))
        .route("/note-activity", post(routes::note_activity).layer(DefaultBodyLimit::max(16 * 1024)))
        .route("/webdav/test", post(routes::webdav_test))
        .route("/webdav/sync", post(routes::webdav_sync))
        .route(
            "/note",
            get(routes::read_note)
                .put(routes::save_note)
                .post(routes::create_note),
        )
        .route("/directory", post(routes::create_directory))
        .route("/item", axum::routing::delete(trash::remove))
        .route("/attachment", get(routes::download).post(routes::upload))
        .route("/image", get(routes::image))
        .route("/pdf", get(routes::pdf))
        .route("/search-text", get(routes::search_text))
        .route("/export/vault", get(routes::export_vault))
        .route("/pdf/annotations", get(routes::pdf_annotations).put(routes::save_pdf_annotations)
            .layer(DefaultBodyLimit::max(2 * 1024 * 1024 + 1024)))
        .route("/trash", get(trash::list))
        .route("/trash/{id}/restore", post(trash::restore))
        .route("/operations/{id}", get(jobs::get).post(jobs::submit))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found", "API 不存在") })
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::protect));
    Router::new()
        .route(
            "/api/login",
            post(auth::login).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .nest("/api", api)
        .fallback_service(ServeDir::new(&state.frontend).append_index_html_on_directories(true))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn(response_headers))
        .with_state(state)
}
