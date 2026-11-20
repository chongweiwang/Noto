use std::{env, net::SocketAddr, path::PathBuf};

pub struct Config {
    pub vault: PathBuf,
    pub data: PathBuf,
    pub frontend: PathBuf,
    pub listen: SocketAddr,
    pub password: Option<String>,
    pub allow_short_password: bool,
    pub secure_cookie: bool,
    pub public_origin: Option<String>,
    pub local_origin: Option<String>,
}
impl Config {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let required = |key| {
            env::var_os(key)
                .map(PathBuf::from)
                .ok_or_else(|| format!("必须配置 {key}"))
        };
        let password = if let Some(file) = env::var_os("NOTO_PASSWORD_FILE") {
            Some(
                std::fs::read_to_string(file)?
                    .trim_end_matches(['\r', '\n'])
                    .to_owned(),
            )
        } else {
            env::var("NOTO_PASSWORD").ok()
        };
        let read_origin = |key: &str| -> Result<Option<String>, Box<dyn std::error::Error>> {
            let origin = env::var(key).ok().filter(|v| !v.is_empty());
            if let Some(value) = &origin {
                if key == "NOTO_LOCAL_ORIGIN" && value == "auto" {
                    return Ok(origin);
                }
                let uri: axum::http::Uri = value.parse()?;
                if !matches!(uri.scheme_str(), Some("http" | "https"))
                    || uri.authority().is_none()
                    || uri.path() != "/"
                    || uri.query().is_some()
                    || value.ends_with('/')
                {
                    return Err(format!("{key} 应为 http(s)://主机:端口，不含路径及结尾斜杠").into());
                }
            }
            Ok(origin)
        };
        let public_origin = read_origin("NOTO_PUBLIC_ORIGIN")?;
        let local_origin = read_origin("NOTO_LOCAL_ORIGIN")?;
        Ok(Self {
            vault: required("NOTO_VAULT_DIR")?,
            data: required("NOTO_DATA_DIR")?,
            frontend: required("NOTO_STATIC_DIR")?,
            listen: env::var("NOTO_LISTEN")
                .unwrap_or_else(|_| "127.0.0.1:3457".into())
                .parse()?,
            password,
            allow_short_password: env::var("NOTO_ALLOW_SHORT_PASSWORD").is_ok_and(|v| v == "true"),
            secure_cookie: env::var("NOTO_SECURE_COOKIE").is_ok_and(|v| v == "true"),
            public_origin,
            local_origin,
        })
    }
}
