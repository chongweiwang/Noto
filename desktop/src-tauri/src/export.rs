use atomicwrites::{AllowOverwrite, AtomicFile};
use std::{fs, io::Write, path::Path};
pub const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

pub fn validate_html(html: &str) -> Result<(), String> {
    if html.len() > MAX_EXPORT_BYTES { return Err("导出内容超过大小上限（64 MiB）".into()); }
    if !html.starts_with("<!DOCTYPE html>") { return Err("导出文档格式无效".into()); }
    Ok(())
}
pub fn write_html(path: &Path, html: &str) -> Result<(), String> {
    validate_html(html)?;
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("html")) {
        return Err("请选择 .html 文件，不能覆盖 Markdown 或其他类型文件".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() { return Err("导出目标必须是普通 HTML 文件".into()); }
    }
    AtomicFile::new(path, AllowOverwrite).write(|file| {
        file.write_all(html.as_bytes())?;
        file.sync_all()
    }).map_err(|error| format!("无法保存导出文件：{error}"))
}
pub fn write_output(path: &Path, ext: &str, write: impl FnOnce(&mut fs::File) -> Result<(), String>) -> Result<(), String> {
    if !path.extension().is_some_and(|value| value.eq_ignore_ascii_case(ext)) {
        return Err(format!("请选择 .{ext} 导出文件"));
    }
    if fs::symlink_metadata(path).is_ok_and(|info| !info.is_file() || info.file_type().is_symlink()) {
        return Err("导出目标必须是普通文件".into());
    }
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| { write(file)?; file.sync_all().map_err(|e| e.to_string()) })
        .map_err(|error| format!("无法保存导出文件：{error}"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_output_is_atomic_and_does_not_overwrite_other_files() {
        let root=tempfile::tempdir().unwrap();
        let html=root.path().join("中文.html");
        fs::write(&html,"旧内容").unwrap();
        assert!(write_html(&html,"不完整文档").is_err());
        assert_eq!(fs::read_to_string(&html).unwrap(),"旧内容");
        write_html(&html,"<!DOCTYPE html><title>中文</title>").unwrap();
        assert!(fs::read_to_string(&html).unwrap().contains("中文"));
        let note=root.path().join("笔记.md");
        fs::write(&note,"原始笔记").unwrap();
        assert!(write_html(&note,"<!DOCTYPE html>").is_err());
        assert_eq!(fs::read_to_string(&note).unwrap(),"原始笔记");
        assert!(write_html(&root.path().join("不存在/输出.html"),"<!DOCTYPE html>").is_err());
        assert!(validate_html(&"x".repeat(MAX_EXPORT_BYTES+1)).is_err());
    }
}
