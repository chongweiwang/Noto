use crate::{error::ApiError, Server};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Request, State},
    http::{header, uri::Authority, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};

pub struct Session {
    pub csrf: String,
    pub expires: Instant,
}
pub struct Auth {
    pub hash: String,
    pub sessions: HashMap<String, Session>,
    pub attempts: Vec<Instant>,
}
pub fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub fn validate_password(password: &str, allow_short: bool) -> Result<(), Box<dyn std::error::Error>> {
    let minimum = if allow_short { 4 } else { 12 };
    if password.chars().count() < minimum {
        return Err(format!("访问口令至少需要 {minimum} 个字符").into());
    }
    Ok(())
}
pub fn hash_password(password: &str, allow_short: bool) -> Result<String, Box<dyn std::error::Error>> {
    validate_password(password, allow_short)?;
    let salt =
        SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes()).map_err(|_| "无法生成口令盐值")?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|v| v.to_string())
        .map_err(|_| "无法生成口令摘要".into())
}
fn cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("noto_session=").map(str::to_owned))
}
fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "登录已失效，请重新登录；本机草稿会保留",
    )
}
fn matches_local_ip(origin: &str, host: &str) -> bool {
    if origin.strip_prefix("http://") != Some(host) || host.contains('@') {
        return false;
    }
    let Ok(authority) = host.parse::<Authority>() else {
        return false;
    };
    let hostname = authority.host();
    if host != hostname && authority.port_u16().is_none() {
        return false;
    }
    // Match IP literals only, so DNS changes cannot turn another site into a LAN origin.
    match hostname.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback(),
        Ok(IpAddr::V6(ip)) => ip.is_unique_local() || ip.is_loopback(),
        Err(_) => false,
    }
}

/// Returns true for an allowed local HTTP origin, which needs a non-Secure cookie.
fn check_origin(state: &Server, headers: &HeaderMap) -> Result<bool, ApiError> {
    let rejected = || ApiError::new(StatusCode::FORBIDDEN, "origin", "拒绝跨来源访问");
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return Err(rejected());
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(false);
    };
    let origin = origin.to_str().map_err(|_| rejected())?;
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let local = state.local_origin.as_deref();
    let local_match = match local {
        Some("auto") => matches_local_ip(origin, host),
        Some(local) => origin == local,
        None => false,
    };
    if local_match {
        return Ok(origin.starts_with("http://"));
    }
    let public_match = match state.public_origin.as_deref() {
        Some(public) => origin == public,
        None if local == Some("auto") => false,
        None => {
            let prefix = if state.secure_cookie { "https://" } else { "http://" };
            origin.strip_prefix(prefix) == Some(host)
        }
    };
    if public_match {
        return Ok(false);
    }
    Err(rejected())
}
pub async fn protect(
    State(state): State<std::sync::Arc<Server>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    check_origin(&state, request.headers())?;
    {
        let mut auth = state.auth.lock().map_err(|_| ApiError::internal())?;
        auth.sessions.retain(|_, v| v.expires > Instant::now());
        let id = cookie(request.headers()).ok_or_else(unauthorized)?;
        let session = auth.sessions.get(&id).ok_or_else(unauthorized)?;
        if !matches!(
            *request.method(),
            axum::http::Method::GET | axum::http::Method::HEAD
        ) && request
            .headers()
            .get("x-noto-csrf")
            .and_then(|v| v.to_str().ok())
            != Some(&session.csrf)
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "csrf",
                "请求校验失效，请重新登录",
            ));
        }
    }
    Ok(next.run(request).await)
}
#[derive(Deserialize)]
pub struct Login {
    password: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub server_id: String,
    pub vault_id: String,
    pub vault: String,
    pub csrf: String,
}
fn identity(state: &Server, csrf: String) -> Identity {
    Identity {
        server_id: state.identity.server_id.clone(),
        vault_id: state.identity.vault_id.clone(),
        vault: state.name.clone(),
        csrf,
    }
}
pub async fn login(
    State(state): State<std::sync::Arc<Server>>,
    headers: HeaderMap,
    Json(body): Json<Login>,
) -> Result<Response, ApiError> {
    let local_http = check_origin(&state, &headers)?;
    let hash = {
        let mut auth = state.auth.lock().map_err(|_| ApiError::internal())?;
        auth.attempts
            .retain(|time| time.elapsed() < Duration::from_secs(60));
        if auth.attempts.len() >= 10 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit",
                "登录尝试过多，请稍后再试",
            ));
        }
        auth.attempts.push(Instant::now());
        auth.hash.clone()
    };
    let verified = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(body.password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .map_err(|_| ApiError::internal())?;
    if !verified {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "访问口令不正确",
        ));
    }
    let id = token();
    let csrf = token();
    {
        let mut auth = state.auth.lock().map_err(|_| ApiError::internal())?;
        auth.sessions.retain(|_, v| v.expires > Instant::now());
        if auth.sessions.len() >= 128 {
            auth.sessions.clear();
        }
        auth.sessions.insert(
            id.clone(),
            Session {
                csrf: csrf.clone(),
                expires: Instant::now() + Duration::from_secs(12 * 3600),
            },
        );
    }
    let cookie = format!(
        "noto_session={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{}",
        if state.secure_cookie && !local_http { "; Secure" } else { "" }
    );
    Ok(([(header::SET_COOKIE, cookie)], Json(identity(&state, csrf))).into_response())
}
pub async fn session(
    State(state): State<std::sync::Arc<Server>>,
    headers: HeaderMap,
) -> Result<Json<Identity>, ApiError> {
    let id = cookie(&headers).ok_or_else(unauthorized)?;
    let auth = state.auth.lock().map_err(|_| ApiError::internal())?;
    let session = auth
        .sessions
        .get(&id)
        .filter(|s| s.expires > Instant::now())
        .ok_or_else(unauthorized)?;
    Ok(Json(identity(&state, session.csrf.clone())))
}
pub async fn logout(
    State(state): State<std::sync::Arc<Server>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(id) = cookie(&headers) {
        state
            .auth
            .lock()
            .map_err(|_| ApiError::internal())?
            .sessions
            .remove(&id);
    }
    Ok((
        [(
            header::SET_COOKIE,
            "noto_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        )],
        StatusCode::NO_CONTENT,
    )
        .into_response())
}
