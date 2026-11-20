use crate::{Vault, VaultEntry, VaultError};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn visible_file(vault: &Vault, relative: &str) -> Result<File, VaultError> {
    let resolved = vault.item_path(relative)?;
    let mut current = vault.root().to_path_buf();
    for component in relative.split('/') {
        current.push(component);
        if component.starts_with('.') || fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(VaultError::InvalidPath);
        }
    }
    if !resolved.is_file() {
        return Err(VaultError::InvalidPath);
    }
    Ok(File::open(resolved)?)
}

impl Vault {
    pub fn export_zip(&self, output: impl Write + Seek) -> Result<(), VaultError> {
        fn add(
            vault: &Vault,
            zip: &mut ZipWriter<impl Write + Seek>,
            entries: &[VaultEntry],
        ) -> Result<(), VaultError> {
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for entry in entries {
                if let Some(issue) = &entry.issue {
                    return Err(VaultError::Write(format!("{}：{issue}", entry.name)));
                }
                if entry.is_directory {
                    zip.add_directory(format!("{}/", entry.path), options)
                        .map_err(zip_error)?;
                    add(vault, zip, &entry.children)?;
                } else {
                    let mut file = visible_file(vault, &entry.path)?;
                    zip.start_file(
                        &entry.path,
                        options.large_file(file.metadata()?.len() >= u32::MAX as u64),
                    )
                    .map_err(zip_error)?;
                    io::copy(&mut file, zip)?;
                }
            }
            Ok(())
        }
        let entries = self.list()?;
        let mut zip = ZipWriter::new(output);
        add(self, &mut zip, &entries)?;
        zip.finish().map_err(zip_error)?;
        Ok(())
    }

    pub fn read_search_text(&self, relative: &str) -> Result<String, VaultError> {
        const LIMIT: u64 = 1024 * 1024;
        let extension = Path::new(relative)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "txt"
                | "csv"
                | "tsv"
                | "json"
                | "yaml"
                | "yml"
                | "log"
                | "xml"
                | "ini"
                | "toml"
                | "srt"
                | "vtt"
        ) {
            return Err(VaultError::InvalidPath);
        }
        let mut bytes = Vec::new();
        visible_file(self, relative)?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > LIMIT {
            return Err(VaultError::Write("文本附件超过 1 MiB".into()));
        }
        if bytes.contains(&0) {
            return Err(VaultError::InvalidUtf8);
        }
        let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        Ok(std::str::from_utf8(content)
            .map_err(|_| VaultError::InvalidUtf8)?
            .to_owned())
    }
}

fn zip_error(error: zip::result::ZipError) -> VaultError {
    VaultError::Write(format!("无法生成 ZIP：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn archive_keeps_binary_and_unicode_files_and_omits_internal_state() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("附件")).unwrap();
        fs::create_dir(root.join("空目录")).unwrap();
        fs::create_dir(root.join(".noto-history")).unwrap();
        fs::write(root.join(".noto-history/private.txt"), "private").unwrap();
        fs::write(root.join("附件/photo.png"), [0, 1, 255]).unwrap();
        fs::write(root.join("附件/文字.txt"), "\u{feff}中文").unwrap();
        let vault = Vault::open(root).unwrap();
        let mut output = Cursor::new(Vec::new());
        vault.export_zip(&mut output).unwrap();
        let mut archive = zip::ZipArchive::new(output).unwrap();
        assert_eq!(archive.len(), 4);
        assert!(archive.by_name("空目录/").unwrap().is_dir());
        assert!(archive.by_name(".noto-history/private.txt").is_err());
        let mut bytes = Vec::new();
        archive
            .by_name("附件/photo.png")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, [0, 1, 255]);
        assert_eq!(vault.read_search_text("附件/文字.txt").unwrap(), "中文");
        for path in [
            ".noto-history/private.txt",
            "../escape.txt",
            "附件/photo.png",
        ] {
            assert!(vault.read_search_text(path).is_err());
        }
    }
}
