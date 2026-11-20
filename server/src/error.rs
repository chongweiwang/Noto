use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use noto_core::VaultError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    #[serde(skip)]
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ApiError {}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: &str) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn invalid() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "请使用知识库内的可见相对路径",
        )
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage",
            "服务端文件操作失败，请检查存储空间、挂载权限和服务日志",
        )
    }
}
impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        VaultError::Io(error).into()
    }
}
impl From<VaultError> for ApiError {
    fn from(error: VaultError) -> Self {
        use std::io::ErrorKind;
        let (status, code, message) = match error {
            VaultError::Conflict => (
                StatusCode::CONFLICT,
                "conflict",
                "文件已被外部修改，当前编辑未保存",
            ),
            VaultError::InvalidPath => return Self::invalid(),
            VaultError::UnsupportedFile => (
                StatusCode::BAD_REQUEST,
                "unsupported",
                "仅支持 .md/.markdown、.canvas 画布或 .drawing 白板",
            ),
            VaultError::UnsupportedMove => (
                StatusCode::BAD_REQUEST,
                "unsupported",
                "当前挂载不支持安全的目录移动；WSL 请将知识库放在 Linux 目录中，再挂载到容器",
            ),
            VaultError::InvalidDrawing => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported", "白板 JSON 格式或元素无效，无法安全写入"),
            VaultError::DrawingTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large", "白板超过 8 MiB、2000 元素或笔迹点数上限"),
            VaultError::InvalidCanvas => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported", "画布 JSON 结构无效，无法安全写入"),
            error @ (VaultError::InvalidPdf | VaultError::InvalidPdfAnnotations) => {
                return Self::new(StatusCode::UNPROCESSABLE_ENTITY, "unsupported", &error.to_string());
            }
            error @ VaultError::PdfTooLarge => {
                return Self::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", &error.to_string());
            }
            VaultError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large", "画布超过 4 MiB 或 1000 节点/3000 连接上限"),
            VaultError::InvalidUtf8 => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "encoding",
                "文件不是有效的 UTF-8，无法安全打开",
            ),
            VaultError::MixedLineEndings => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "encoding",
                "文件包含混合换行符，请另存为新文件",
            ),
            VaultError::Io(ref e) if e.kind() == ErrorKind::NotFound => {
                (StatusCode::NOT_FOUND, "not_found", "文件不存在或已被删除")
            }
            VaultError::Io(ref e) if e.kind() == ErrorKind::AlreadyExists => (
                StatusCode::CONFLICT,
                "already_exists",
                "目标已存在，不会覆盖",
            ),
            VaultError::Io(ref e)
                if matches!(
                    e.kind(),
                    ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
                ) || e.raw_os_error() == Some(30) =>
            {
                (
                    StatusCode::FORBIDDEN,
                    "permission",
                    "目录不可写或没有文件访问权限，请检查挂载设置",
                )
            }
            other => {
                eprintln!("Noto storage error: {other}");
                return Self::internal();
            }
        };
        Self::new(status, code, message)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self)).into_response()
    }
}
