use super::{content_version, Vault, VaultError};
use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::PathBuf,
};

const MAX_PDF_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ANNOTATION_BYTES: u64 = 2 * 1024 * 1024;
const ANNOTATION_DIR: &str = "PDF 标注";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDocument {
    pub data: String,
    pub version: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AnnotationKind {
    Highlight,
    Underline,
    Note,
}

#[derive(Deserialize, Serialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Annotation {
    id: String,
    page: u32,
    kind: AnnotationKind,
    rects: Vec<Rect>,
    text: String,
    comment: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotations {
    revision: Option<String>,
    annotations: Vec<Annotation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotationUpdate {
    document_version: String,
    expected_revision: Option<String>,
    annotations: Vec<Annotation>,
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256-").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn valid_annotations(annotations: &[Annotation]) -> bool {
    let mut ids = HashSet::new();
    annotations.len() <= 2000
        && annotations.iter().all(|annotation| {
            annotation.id.len() == 32
                && annotation.id.bytes().all(|b| b.is_ascii_hexdigit())
                && ids.insert(&annotation.id)
                && (1..=100_000).contains(&annotation.page)
                && annotation.text.len() <= 8192
                && annotation.comment.len() <= 8192
                && (1..=80).contains(&annotation.rects.len())
                && annotation.rects.iter().all(|r| {
                    (0.0..=1.0).contains(&r.x)
                        && (0.0..=1.0).contains(&r.y)
                        && r.width > 0.0
                        && r.height > 0.0
                        && r.x + r.width <= 1.000001
                        && r.y + r.height <= 1.000001
                })
        })
}

impl Vault {
    fn pdf_bytes(&self, path: &str) -> Result<Vec<u8>, VaultError> {
        let path = self.item_path(path)?;
        if !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            || !path.is_file()
        {
            return Err(VaultError::InvalidPdf);
        }
        let file = fs::File::open(path)?;
        if file.metadata()?.len() > MAX_PDF_BYTES {
            return Err(VaultError::PdfTooLarge);
        }
        let mut bytes = Vec::new();
        file.take(MAX_PDF_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_PDF_BYTES {
            return Err(VaultError::PdfTooLarge);
        }
        if !bytes[..bytes.len().min(1024)]
            .windows(5)
            .any(|prefix| prefix == b"%PDF-")
        {
            return Err(VaultError::InvalidPdf);
        }
        Ok(bytes)
    }

    pub fn read_pdf(&self, path: &str) -> Result<PdfDocument, VaultError> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let bytes = self.pdf_bytes(path)?;
        Ok(PdfDocument {
            version: content_version(&bytes),
            data: STANDARD.encode(bytes),
        })
    }

    fn pdf_annotation_path(&self, version: &str) -> Result<PathBuf, VaultError> {
        if !valid_digest(version) {
            return Err(VaultError::InvalidPath);
        }
        let dir = self.root().join(ANNOTATION_DIR);
        match fs::symlink_metadata(&dir) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
            Ok(_) => return Err(VaultError::InvalidPath),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(dir.join(format!("{version}.json")))
    }

    pub fn read_pdf_annotations(&self, version: &str) -> Result<PdfAnnotations, VaultError> {
        let path = self.pdf_annotation_path(version)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(VaultError::InvalidPath),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(PdfAnnotations::default())
            }
            Err(error) => return Err(error.into()),
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_ANNOTATION_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ANNOTATION_BYTES {
            return Err(VaultError::InvalidPdfAnnotations);
        }
        let annotations: Vec<Annotation> =
            serde_json::from_slice(&bytes).map_err(|_| VaultError::InvalidPdfAnnotations)?;
        if !valid_annotations(&annotations) {
            return Err(VaultError::InvalidPdfAnnotations);
        }
        Ok(PdfAnnotations {
            revision: Some(content_version(&bytes)),
            annotations,
        })
    }

    pub fn save_pdf_annotations(
        &self,
        path: &str,
        update: PdfAnnotationUpdate,
    ) -> Result<PdfAnnotations, VaultError> {
        if !valid_annotations(&update.annotations) {
            return Err(VaultError::InvalidPdfAnnotations);
        }
        let _guard = self.lock_writes()?;
        if content_version(&self.pdf_bytes(path)?) != update.document_version {
            return Err(VaultError::Conflict);
        }
        let destination = self.pdf_annotation_path(&update.document_version)?;
        let current = self.read_pdf_annotations(&update.document_version)?;
        let bytes = serde_json::to_vec(&update.annotations)
            .map_err(|_| VaultError::InvalidPdfAnnotations)?;
        if bytes.len() as u64 > MAX_ANNOTATION_BYTES {
            return Err(VaultError::InvalidPdfAnnotations);
        }
        let revision = Some(content_version(&bytes));
        if revision == current.revision {
            return Ok(current);
        }
        if current.revision != update.expected_revision {
            return Err(VaultError::Conflict);
        }
        fs::create_dir_all(destination.parent().ok_or(VaultError::InvalidPath)?)?;
        AtomicFile::new(destination, AllowOverwrite)
            .write(|file| file.write_all(&bytes))
            .map_err(|error| VaultError::Write(error.to_string()))?;
        Ok(PdfAnnotations {
            revision,
            annotations: update.annotations,
        })
    }
}
