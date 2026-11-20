use crate::state::{DesktopState, Draft, Status};
use base64::{engine::general_purpose::STANDARD, Engine};
use noto_core::{Note, VaultEntry, HistoryEntry, HistorySnapshot};
use std::{
    fs,
    io::{Read, Write},
    sync::Arc,
    path::{Component, Path},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn status(state: State<'_, DesktopState>) -> Result<Status, String> {
    state.status()
}

#[tauri::command]
async fn storage_diagnostics(
    state: State<'_, DesktopState>,
) -> Result<noto_core::StorageDiagnostics, String> {
    let (vault, data) = state.storage_paths()?;
    tauri::async_runtime::spawn_blocking(move || {
        noto_core::StorageDiagnostics::probe(vault.as_deref(), &data)
    })
    .await
    .map_err(|_| "存储检查中断，请重试".to_owned())
}

#[tauri::command]
fn select_vault(state: State<'_, DesktopState>, path: String) -> Result<Status, String> {
    state.select_vault(&path)
}

#[tauri::command]
fn create_vault(
    state: State<'_, DesktopState>,
    parent: String,
    name: String,
) -> Result<Status, String> {
    let name_path = Path::new(&name);
    if name.trim().is_empty()
        || name_path.components().count() != 1
        || !name_path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("请输入有效的文件夹名称".into());
    }
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent.is_dir() {
        return Err("请选择有效的父目录".into());
    }
    let path = parent.join(name_path);
    fs::create_dir(&path).map_err(|e| format!("无法创建知识库：{e}"))?;
    state.select_vault(&path.to_string_lossy())
}

#[tauri::command]
fn list_entries(state: State<'_, DesktopState>) -> Result<Vec<VaultEntry>, String> {
    state.vault()?.list().map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note(state: State<'_, DesktopState>, path: String) -> Result<Note, String> {
    state.vault()?.read_note(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_history(state: State<'_, DesktopState>, path: String) -> Result<Vec<HistoryEntry>, String> {
    state.vault()?.file_history(&path).map_err(|e| e.to_string())
}
#[tauri::command]
fn read_history(state: State<'_, DesktopState>, path: String, id: String) -> Result<HistorySnapshot, String> {
    state.vault()?.read_history(&path, &id).map_err(|e| e.to_string())
}
#[tauri::command]
fn checkpoint_history(state: State<'_, DesktopState>, path: String, content: String, expected_version: String) -> Result<(), String> {
    state.vault()?.checkpoint_history(&path, &content, &expected_version).map_err(|e| e.to_string())
}

#[tauri::command]
async fn note_activity(state: State<'_, DesktopState>, day_starts: Vec<u64>) -> Result<Vec<noto_core::NoteActivityDay>, String> {
    let vault = state.vault()?;
    tauri::async_runtime::spawn_blocking(move || vault.note_activity(&day_starts).map_err(|error| error.to_string()))
        .await.map_err(|_| "笔记活动读取中断，请重试".to_owned())?
}

#[tauri::command]
async fn webdav_test(config:noto_core::webdav::WebDavConfig)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||noto_core::webdav::test_connection(config)).await.map_err(|_|"WebDAV 测试任务中断".to_owned())?
}
#[tauri::command]
async fn webdav_sync(state:State<'_,DesktopState>,mut input:noto_core::webdav::WebDavSync)->Result<noto_core::webdav::WebDavReport,String>{
    let vault=state.vault()?;
    input.protected_paths.extend(state.drafts()?.into_iter().map(|d|d.path));input.protected_paths.sort();input.protected_paths.dedup();
    tauri::async_runtime::spawn_blocking(move||vault.sync_webdav(input)).await.map_err(|_|"WebDAV 同步任务中断，请重试检查结果".to_owned())?
}

#[tauri::command]
fn save_note(
    state: State<'_, DesktopState>,
    path: String,
    content: String,
    expected_version: String,
) -> Result<Note, String> {
    state
        .vault()?
        .save_note(&path, &content, &expected_version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_note(
    state: State<'_, DesktopState>,
    path: String,
    content: String,
) -> Result<Note, String> {
    state
        .vault()?
        .create_note(&path, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn backup_document(state:State<'_,DesktopState>,path:String,backup_root:String,expected_version:String)->Result<(),String>{
    state.vault()?.backup_document(&path,&backup_root,&expected_version).map_err(|e|e.to_string())
}

#[tauri::command]
fn create_directory(state: State<'_, DesktopState>, path: String) -> Result<(), String> {
    state
        .vault()?
        .create_directory(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn move_item(state: State<'_, DesktopState>, from: String, to: String) -> Result<(), String> {
    state
        .vault()?
        .move_item(&from, &to)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_item(state: State<'_, DesktopState>, path: String) -> Result<(), String> {
    let vault = state.vault()?;
    let path = vault.item_path(&path).map_err(|e| e.to_string())?;
    trash::delete(path).map_err(|e| format!("无法移至系统回收站：{e}"))
}

#[tauri::command]
fn import_attachment(
    state: State<'_, DesktopState>,
    note: String,
    source: String,
) -> Result<String, String> {
    state
        .vault()?
        .import_attachment(&note, Path::new(&source))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn import_attachment_data(
    state: State<'_, DesktopState>,
    note: String,
    name: String,
    data: String,
) -> Result<String, String> {
    if data.len() > 24 * 1024 * 1024 {
        return Err("图片粘贴或拖入上限为 16 MB，请使用导入附件".into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| "附件数据格式无效")?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("图片粘贴或拖入上限为 16 MB，请使用导入附件".into());
    }
    state
        .vault()?
        .import_attachment_bytes(&note, &name, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_image(
    state: State<'_, DesktopState>,
    note: String,
    link: String,
) -> Result<String, String> {
    let vault = state.vault()?;
    let path = vault
        .attachment_path(&note, &link)
        .map_err(|e| e.to_string())?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    if !matches!(mime.essence_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/bmp" | "image/svg+xml") {
        return Err("附件不是支持的图片".into());
    }
    let bytes = bounded_image(&path)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn bounded_image(path: &Path) -> Result<Vec<u8>, String> {
    const LIMIT: u64=32 * 1024 * 1024;
    let file=fs::File::open(path).map_err(|e|e.to_string())?;
    if file.metadata().map_err(|e|e.to_string())?.len()>LIMIT {return Err("图片超过 32 MiB".into());}
    let mut bytes=Vec::new();
    file.take(LIMIT+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len() as u64>LIMIT {return Err("图片超过 32 MiB".into());}
    Ok(bytes)
}

#[tauri::command]
async fn save_export_html(app:tauri::AppHandle, window:tauri::WebviewWindow, state:State<'_,DesktopState>, html:String, suggested_name:String) -> Result<Option<String>,String> {
    crate::export::validate_html(&html)?;
    if suggested_name.contains(['/', '\\']) || suggested_name.len()>1024 {return Err("导出名称无效".into());}
    let original=state.vault()?;
    let selected=tauri::async_runtime::spawn_blocking(move||app.dialog().file().set_parent(&window).add_filter("HTML", &["html"]).set_file_name(suggested_name).blocking_save_file())
        .await.map_err(|e|e.to_string())?;
    let Some(selected)=selected else {return Ok(None);};
    if !Arc::ptr_eq(&original,&state.vault()?) {return Err("知识库已切换，请重新导出".into());}
    let path=selected.into_path().map_err(|e|e.to_string())?;
    let result=path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move||crate::export::write_html(&path,&html)).await.map_err(|e|e.to_string())??;
    Ok(Some(result))
}

#[tauri::command]
async fn save_export_svg(app:tauri::AppHandle, window:tauri::WebviewWindow, state:State<'_,DesktopState>, svg:String, suggested_name:String) -> Result<Option<String>,String> {
    crate::svg_export::validate_svg(&svg)?;
    if suggested_name.is_empty() || suggested_name.contains(['/', '\\', ':']) || suggested_name.chars().any(char::is_control) || suggested_name.len()>1024 {return Err("导出名称无效".into());}
    let original=state.vault()?;
    let selected=tauri::async_runtime::spawn_blocking(move||app.dialog().file().set_parent(&window).add_filter("SVG", &["svg"]).set_file_name(suggested_name).blocking_save_file())
        .await.map_err(|e|e.to_string())?;
    let Some(selected)=selected else {return Ok(None);};
    if !Arc::ptr_eq(&original,&state.vault()?) {return Err("知识库已切换，请重新导出".into());}
    let path=selected.into_path().map_err(|e|e.to_string())?;
    let result=path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move||crate::svg_export::write_svg(&path,&svg)).await.map_err(|e|e.to_string())??;
    Ok(Some(result))
}

async fn choose_output(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    ext: &'static str,
    name: String,
) -> Result<Option<std::path::PathBuf>, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.chars().any(char::is_control) || name.len() > 1024 {
        return Err("导出名称无效".into());
    }
    let choice = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_parent(&window).add_filter(ext.to_uppercase(), &[ext]).set_file_name(name).blocking_save_file()
    }).await.map_err(|err| err.to_string())?;
    choice.map(|selected| selected.into_path().map_err(|err| err.to_string())).transpose()
}

#[tauri::command]
async fn save_export_graphic(
    app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, DesktopState>,
    data: String, suggested_name: String, format: String,
) -> Result<Option<String>, String> {
    let (ext, magic): (&str, &[u8]) = match format.as_str() {
        "png" => ("png", b"\x89PNG\r\n\x1a\n"),
        "pdf" => ("pdf", b"%PDF-"),
        _ => return Err("图形导出格式无效".into()),
    };
    if data.len() > crate::export::MAX_EXPORT_BYTES.div_ceil(3) * 4 {
        return Err("图形超过 64 MiB".into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| "图形编码无效")?;
    if !bytes.starts_with(magic) { return Err("图形文件无效".into()); }
    let vault = state.vault()?;
    let Some(path) = choose_output(app, window, ext, suggested_name).await? else { return Ok(None); };
    if !Arc::ptr_eq(&vault, &state.vault()?) { return Err("知识库已切换，请重新导出".into()); }
    let result = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || crate::export::write_output(&path, ext, |file| {
        file.write_all(&bytes).map_err(|err| err.to_string())
    })).await.map_err(|err| err.to_string())??;
    Ok(Some(result))
}

#[tauri::command]
async fn save_vault_zip(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, DesktopState>) -> Result<Option<String>, String> {
    let vault = state.vault()?;
    let Some(path) = choose_output(app, window, "zip", "noto-vault.zip".into()).await? else { return Ok(None); };
    if !Arc::ptr_eq(&vault, &state.vault()?) { return Err("知识库已切换，请重新导出".into()); }
    let result = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || crate::export::write_output(&path, "zip", |file| {
        vault.export_zip(file).map_err(|err| err.to_string())
    })).await.map_err(|err| err.to_string())??;
    Ok(Some(result))
}

#[tauri::command]
async fn read_search_text(state: State<'_, DesktopState>, path: String) -> Result<String, String> {
    let vault = state.vault()?;
    tauri::async_runtime::spawn_blocking(move || vault.read_search_text(&path).map_err(|err| err.to_string()))
        .await.map_err(|err| err.to_string())?
}


#[tauri::command]
async fn read_pdf(state: State<'_, DesktopState>, path: String) -> Result<noto_core::PdfDocument, String> {
    let vault = state.vault()?;
    tauri::async_runtime::spawn_blocking(move || vault.read_pdf(&path).map_err(|e| e.to_string()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_pdf_annotations(state: State<'_, DesktopState>, version: String) -> Result<noto_core::PdfAnnotations, String> {
    let vault = state.vault()?;
    tauri::async_runtime::spawn_blocking(move || vault.read_pdf_annotations(&version).map_err(|e| e.to_string()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_pdf_annotations(state: State<'_, DesktopState>, path: String, update: noto_core::PdfAnnotationUpdate) -> Result<noto_core::PdfAnnotations, String> {
    let vault = state.vault()?;
    tauri::async_runtime::spawn_blocking(move || vault.save_pdf_annotations(&path, update).map_err(|e| e.to_string()))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_attachment(
    state: State<'_, DesktopState>,
    note: String,
    link: String,
) -> Result<(), String> {
    let vault = state.vault()?;
    let path = vault
        .attachment_path(&note, &link)
        .map_err(|e| e.to_string())?;
    open::that(path).map_err(|e| format!("无法打开附件：{e}"))
}

#[tauri::command]
fn open_item(state: State<'_, DesktopState>, path: String) -> Result<(), String> {
    let vault = state.vault()?;
    let path = vault.item_path(&path).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("请选择文件".into());
    }
    open::that(path).map_err(|e| format!("无法打开文件：{e}"))
}

fn external_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "链接格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("只允许打开 HTTP、HTTPS 和邮件链接".into());
    }
    Ok(parsed)
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = external_url(&url)?;
    open::that(parsed.as_str()).map_err(|e| format!("无法打开链接：{e}"))
}

#[tauri::command]
fn list_drafts(state: State<'_, DesktopState>) -> Result<Vec<Draft>, String> {
    state.drafts()
}
#[tauri::command]
fn write_draft(state: State<'_, DesktopState>, draft: Draft) -> Result<(), String> {
    state.write_draft(&draft)
}
#[tauri::command]
fn remove_draft(state: State<'_, DesktopState>, path: String) -> Result<(), String> {
    state.remove_draft(&path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = if cfg!(debug_assertions) {
                std::env::var_os("NOTO_TEST_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
            app.manage(DesktopState::new(data));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            storage_diagnostics,
            select_vault,
            create_vault,
            list_entries,
            read_note,
            file_history,
            read_history,
            checkpoint_history,
            note_activity,
            webdav_test,
            webdav_sync,
            save_note,
            create_note,
            create_directory,
            move_item,
            delete_item,
            import_attachment,
            import_attachment_data,
            read_image,
            read_pdf,
            read_search_text,
            read_pdf_annotations,
            save_pdf_annotations,
            save_export_html,
            save_export_svg,
            save_export_graphic,
            save_vault_zip,
            backup_document,
            open_attachment,
            open_item,
            open_external,
            list_drafts,
            write_draft,
            remove_draft
        ])
        .run(tauri::generate_context!())
        .expect("桌面应用启动失败");
}

#[cfg(test)]
#[path="../../../crates/noto-core/tests/support/webdav.rs"] mod webdav_fixture;
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{
            get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
        },
        webview::InvokeRequest,
        WebviewWindow,
    };

    #[test]
    fn image_limit_is_checked_before_reading() {
        let root=tempfile::tempdir().unwrap();
        let path=root.path().join("large.png");
        fs::File::create(&path).unwrap().set_len(32*1024*1024+1).unwrap();
        assert!(bounded_image(&path).unwrap_err().contains("32 MiB"));
        fs::write(&path,b"image bytes").unwrap();
        assert_eq!(bounded_image(&path).unwrap(),b"image bytes");
    }

    #[test]
    fn external_links_allow_only_web_and_mail_schemes() {
        for url in [
            "https://example.org/a",
            "http://example.org",
            "mailto:user@example.org",
        ] {
            assert!(external_url(url).is_ok());
        }
        for url in [
            "file:///C:/test",
            "javascript:alert(1)",
            "cmd:calc",
            "not a url",
        ] {
            assert!(external_url(url).is_err());
        }
    }

    fn call(window: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }

    #[test]
    fn ipc_webdav_preserves_all_local_recovery_drafts_even_when_not_declared_by_frontend(){
        let dav=webdav_fixture::DavFixture::new();let dir=tempfile::tempdir().unwrap();let data=tempfile::tempdir().unwrap();fs::write(dir.path().join("a.md"),"disk").unwrap();fs::write(dir.path().join("image.png"),b"\x89PNG\x00").unwrap();
        let app=mock_builder().manage(DesktopState::new(data.path().into())).invoke_handler(tauri::generate_handler![select_vault,read_note,write_draft,webdav_test,webdav_sync]).build(mock_context(noop_assets())).unwrap();
        let window=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();call(&window,"select_vault",json!({"path":dir.path().to_str().unwrap()})).unwrap();let note=call(&window,"read_note",json!({"path":"a.md"})).unwrap();call(&window,"write_draft",json!({"draft":{"path":"a.md","content":"unsaved","baseVersion":note["version"]}})).unwrap();
        let config=json!({"url":dav.url,"username":"user","password":"pass","remotePath":"Noto"});call(&window,"webdav_test",json!({"config":config})).unwrap();dav.model.lock().unwrap().put("/dav/Noto/a.md","remote");
        let result=call(&window,"webdav_sync",json!({"input":{"config":config,"protectedPaths":[],"resolutions":[]}})).unwrap();assert_eq!(result["skipped"][0],"a.md");assert_eq!(result["uploaded"],1);assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(),"disk");
    }

    #[test]
    fn ipc_file_history_protects_unsaved_content_without_replacing_the_file() {
        let dir=tempfile::tempdir().unwrap(); let data=tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "旧内容").unwrap();
        let app=mock_builder().manage(DesktopState::new(data.path().into()))
            .invoke_handler(tauri::generate_handler![select_vault,read_note,save_note,file_history,read_history,checkpoint_history])
            .build(mock_context(noop_assets())).unwrap();
        let window=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
        call(&window,"select_vault",json!({"path":dir.path().to_str().unwrap()})).unwrap();
        let note=call(&window,"read_note",json!({"path":"a.md"})).unwrap();
        let saved=call(&window,"save_note",json!({"path":"a.md","content":"新磁盘内容","expectedVersion":note["version"]})).unwrap();
        let list=call(&window,"file_history",json!({"path":"a.md"})).unwrap();
        let snapshot=call(&window,"read_history",json!({"path":"a.md","id":list[0]["id"]})).unwrap();
        assert_eq!(snapshot["content"],"旧内容");
        assert!(call(&window,"checkpoint_history",json!({"path":"a.md","content":"未保存","expectedVersion":note["version"]})).is_err());
        call(&window,"checkpoint_history",json!({"path":"a.md","content":"未保存","expectedVersion":saved["version"]})).unwrap();
        let list=call(&window,"file_history",json!({"path":"a.md"})).unwrap();
        let snapshot=call(&window,"read_history",json!({"path":"a.md","id":list[0]["id"]})).unwrap();
        assert_eq!(snapshot["content"],"未保存"); assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(),"新磁盘内容");
    }

    #[test]
    fn ipc_selects_real_vault_and_rejects_stale_save() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = dir.path().join("样例.md");
        fs::write(&path, "# 原文\n").unwrap();
        let app = mock_builder()
            .manage(DesktopState::new(data.path().into()))
            .invoke_handler(tauri::generate_handler![
                select_vault,
                read_note,
                save_note,
                create_note,
                import_attachment,
                import_attachment_data,
                read_image,
                write_draft,
                list_drafts
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        call(
            &window,
            "select_vault",
            json!({"path": dir.path().to_str().unwrap()}),
        )
        .unwrap();
        let opened = call(&window, "read_note", json!({"path": "样例.md"})).unwrap();
        let base = opened["version"].as_str().unwrap();
        fs::write(&path, "# 外部修改\n").unwrap();
        assert!(call(
            &window,
            "save_note",
            json!({"path": "样例.md", "content": "本地编辑", "expectedVersion": base})
        )
        .is_err());
        call(
            &window,
            "write_draft",
            json!({"draft": {"path": "样例.md", "content": "本地编辑", "baseVersion": base}}),
        )
        .unwrap();
        assert_eq!(
            call(&window, "list_drafts", json!({})).unwrap()[0]["content"],
            "本地编辑"
        );
        let copy = call(
            &window,
            "create_note",
            json!({"path": "恢复.md", "content": "本地编辑"}),
        )
        .unwrap();
        assert_eq!(copy["content"], "本地编辑");
        assert!(call(
            &window,
            "create_note",
            json!({"path": "样例.md", "content": "覆盖"})
        )
        .is_err());

        let source = tempfile::tempdir().unwrap();
        let image = source.path().join("图片 (1).png");
        fs::write(&image, [1, 2, 3]).unwrap();
        let link = call(
            &window,
            "import_attachment",
            json!({"note": "恢复.md", "source": image.to_str().unwrap()}),
        )
        .unwrap();
        let data_url = call(
            &window,
            "read_image",
            json!({"note": "恢复.md", "link": link}),
        )
        .unwrap();
        assert_eq!(data_url, "data:image/png;base64,AQID");
        let dropped = call(
            &window,
            "import_attachment_data",
            json!({"note":"恢复.md", "name":"图片 (1).png", "data":"BAU="}),
        )
        .unwrap();
        assert_ne!(dropped, link);
        assert_eq!(
            call(
                &window,
                "read_image",
                json!({"note":"恢复.md", "link":dropped})
            )
            .unwrap(),
            "data:image/png;base64,BAU="
        );
        assert!(call(
            &window,
            "import_attachment_data",
            json!({"note":"恢复.md", "name":"../bad.png", "data":"BAU="})
        )
        .is_err());
        assert!(call(
            &window,
            "read_image",
            json!({"note": "恢复.md", "link": "../../outside.png"})
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "# 外部修改\n");
    }
    #[test]
    fn ipc_canvas_reuses_versions_and_persistent_drafts() {
        let root=tempfile::tempdir().unwrap();let data=tempfile::tempdir().unwrap();
        let app=mock_builder().manage(DesktopState::new(data.path().into()))
            .invoke_handler(tauri::generate_handler![select_vault,create_note,read_note,save_note,write_draft,list_drafts,read_image,import_attachment_data,backup_document])
            .build(mock_context(noop_assets())).unwrap();
        let window=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
        call(&window,"select_vault",json!({"path":root.path().to_str().unwrap()})).unwrap();
        let created=call(&window,"create_note",json!({"path":"a.canvas","content":"{\"nodes\":[],\"edges\":[]}"})).unwrap();
        let version=created["version"].as_str().unwrap();
        let content="{\"nodes\":[],\"edges\":[],\"extra\":\"local\"}";
        let saved=call(&window,"save_note",json!({"path":"a.canvas","content":content,"expectedVersion":version})).unwrap();
        assert_eq!(saved["content"],content);
        call(&window,"backup_document",json!({"path":"a.canvas","backupRoot":".noto-structure-backup-ipc","expectedVersion":saved["version"]})).unwrap();
        assert_eq!(fs::read_to_string(root.path().join(".noto-structure-backup-ipc/原文/a.canvas")).unwrap(),content);
        assert!(call(&window,"save_note",json!({"path":"a.canvas","content":"{}","expectedVersion":version})).is_err());
        call(&window,"write_draft",json!({"draft":{"path":"a.canvas","content":"{\"local\":1}","baseVersion":saved["version"]}})).unwrap();
        assert_eq!(call(&window,"list_drafts",json!({})).unwrap()[0]["path"],"a.canvas");
        let image=call(&window,"import_attachment_data",json!({"note":"a.canvas","name":"image.png","data":"AQID"})).unwrap();
        assert!(call(&window,"read_image",json!({"note":"a.canvas","link":image})).unwrap().as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(fs::read_to_string(root.path().join("a.canvas")).unwrap(),content);
    }

    #[test]
    fn ipc_drawing_uses_single_file_version_drafts_and_raw_backup(){
        let root=tempfile::tempdir().unwrap();let data=tempfile::tempdir().unwrap();
        let app=mock_builder().manage(DesktopState::new(data.path().into()))
            .invoke_handler(tauri::generate_handler![select_vault,create_note,read_note,save_note,write_draft,list_drafts,backup_document])
            .build(mock_context(noop_assets())).unwrap();
        let window=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
        call(&window,"select_vault",json!({"path":root.path().to_str().unwrap()})).unwrap();
        let source=json!({"type":"noto-drawing","version":1,"background":"#ffffff","elements":[]}).to_string();
        let created=call(&window,"create_note",json!({"path":"草图.drawing","content":source})).unwrap();
        let next=source.replace("#ffffff","#123456");
        let saved=call(&window,"save_note",json!({"path":"草图.drawing","content":next,"expectedVersion":created["version"]})).unwrap();
        assert_eq!(saved["content"],next);
        assert!(call(&window,"save_note",json!({"path":"草图.drawing","content":source,"expectedVersion":created["version"]})).is_err());
        call(&window,"write_draft",json!({"draft":{"path":"草图.drawing","content":"{broken draft","baseVersion":saved["version"]}})).unwrap();
        assert_eq!(call(&window,"list_drafts",json!({})).unwrap()[0]["content"],"{broken draft");
        call(&window,"backup_document",json!({"path":"草图.drawing","backupRoot":".noto-structure-backup-drawing-ipc","expectedVersion":saved["version"]})).unwrap();
        assert_eq!(fs::read_to_string(root.path().join(".noto-structure-backup-drawing-ipc/原文/草图.drawing")).unwrap(),next);
        assert!(call(&window,"create_note",json!({"path":"bad.drawing","content":"{}"})).is_err());
        assert_eq!(call(&window,"read_note",json!({"path":"草图.drawing"})).unwrap()["content"],next);
    }

}
