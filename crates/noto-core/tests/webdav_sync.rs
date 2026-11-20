#[path="support/webdav.rs"] mod support;
use noto_core::{Vault,webdav::{WebDavConfig,WebDavSync,Resolution,Choice}};
use std::{fs,sync::Arc};
fn config(d:&support::DavFixture)->WebDavConfig{WebDavConfig{url:d.url.clone(),username:"user".into(),password:"pass".into(),remote_path:"Noto".into()}}
fn run(v:&Vault,d:&support::DavFixture)->noto_core::webdav::WebDavReport{let result=v.sync_webdav(WebDavSync{config:config(d),protected_paths:vec![],resolutions:vec![]});if result.as_ref().is_err()||result.as_ref().is_ok_and(|r|!r.errors.is_empty()){eprintln!("Test request sequence: {:?}",d.model.lock().unwrap().calls.iter().map(|(m,p,_)|(m,p)).collect::<Vec<_>>());}result.unwrap()}
#[test]
fn all_visible_file_types_roundtrip_raw_bytes_and_second_run_is_idle(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();fs::create_dir(dir.path().join("附件")).unwrap();
    let files=[("中文 #%.md",b"\xef\xbb\xbf# raw\r\n".as_slice()),("附件/image.png",b"\x89PNG\x00\xff"),("附件/read.pdf",b"%PDF-1.7\x00"),("map.canvas",b"{\"nodes\":[],\"edges\":[]}"),("board.drawing",b"{\"type\":\"noto-drawing\",\"version\":1,\"background\":\"#ffffff\",\"elements\":[]}")];
    for (p,b) in files{fs::write(dir.path().join(p),b).unwrap();}
    fs::create_dir(dir.path().join(".secret")).unwrap();fs::write(dir.path().join(".secret/token"),"never upload").unwrap();
    let r=run(&v,&d);assert!(r.errors.is_empty(),"{:?}",r.errors.iter().map(|e|&e.message).collect::<Vec<_>>());assert_eq!(r.uploaded,5);
    let other=tempfile::tempdir().unwrap();let v2=Vault::open(other.path()).unwrap();let r=run(&v2,&d);assert_eq!(r.downloaded,5);assert!(r.errors.is_empty());
    for (p,b) in files{assert_eq!(fs::read(other.path().join(p)).unwrap(),b);}
    let r=run(&v,&d);assert_eq!(r.uploaded+r.downloaded,0);assert!(r.conflicts.is_empty());
    assert!(d.model.lock().unwrap().files.keys().all(|p|!p.contains(".secret")&&!p.contains(".noto-")));
}
#[test]
fn first_sync_and_both_changed_keep_both_versions_and_resolution_is_version_checked(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();let n=v.create_note("a.md","local").unwrap();d.model.lock().unwrap().put("/dav/Noto/a.md","remote");
    let mut r=run(&v,&d);assert_eq!(r.conflicts.len(),1);assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(),"local");
    let copy=r.conflicts[0].copy.as_ref().unwrap();assert_eq!(fs::read_to_string(dir.path().join(copy)).unwrap(),"remote");
    let conflict=r.conflicts.remove(0);
    let resolve=|choice|WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![Resolution{path:conflict.path.clone(),local_version:conflict.local_version.clone(),remote_version:conflict.remote_version.clone(),choice}]};
    v.save_note("a.md","new local",&n.version).unwrap();let r=v.sync_webdav(resolve(Choice::Remote)).unwrap();assert_eq!(r.errors.len(),1);assert_eq!(v.read_note("a.md").unwrap().content,"new local");
    let c=run(&v,&d).conflicts.remove(0);let r=v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![Resolution{path:c.path,local_version:c.local_version,remote_version:c.remote_version,choice:Choice::Local}]}).unwrap();assert_eq!(r.uploaded,1);
    assert_eq!(d.model.lock().unwrap().files["/dav/Noto/a.md"].0,b"new local");assert_eq!(run(&v,&d).uploaded,0);
    // Reopen the vault: persisted baseline detects concurrent edits, not timestamps.
    drop(v);let v=Vault::open(dir.path()).unwrap();fs::write(dir.path().join("a.md"),"third local").unwrap();d.model.lock().unwrap().put("/dav/Noto/a.md","third remote");assert_eq!(run(&v,&d).conflicts.len(),1);
}
#[test]
fn clean_remote_changes_create_recovery_snapshot_but_dirty_paths_and_races_never_overwrite(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();v.create_note("a.md","base").unwrap();run(&v,&d);
    d.model.lock().unwrap().put("/dav/Noto/a.md","remote change");
    let r=v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec!["a.md".into()],resolutions:vec![]}).unwrap();assert_eq!(r.skipped,["a.md"]);assert_eq!(v.read_note("a.md").unwrap().content,"base");
    let path=dir.path().join("a.md");d.model.lock().unwrap().on_get=Some(Arc::new(move|p|{if p=="/dav/Noto/a.md"{fs::write(&path,"during download").unwrap();}}));
    let r=run(&v,&d);assert_eq!(r.errors.len(),1);assert_eq!(v.read_note("a.md").unwrap().content,"during download");
    d.model.lock().unwrap().on_get=None;fs::write(dir.path().join("a.md"),"base").unwrap();let r=run(&v,&d);assert_eq!(r.downloaded,1);
    let entry=v.file_history("a.md").unwrap().remove(0);assert_eq!(v.read_history("a.md",&entry.id).unwrap().content,"base");
}
#[test]
fn deletions_require_explicit_choice_and_keep_raw_backup(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();v.create_note("a.md","original").unwrap();run(&v,&d);
    d.model.lock().unwrap().files.remove("/dav/Noto/a.md");let mut r=run(&v,&d);assert_eq!(r.conflicts.len(),1);assert!(dir.path().join("a.md").exists());assert!(!d.model.lock().unwrap().files.contains_key("/dav/Noto/a.md"));
    let c=r.conflicts.remove(0);let r=v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![Resolution{path:c.path,local_version:c.local_version,remote_version:c.remote_version,choice:Choice::Remote}]}).unwrap();assert_eq!(r.deleted_local,1);assert!(!dir.path().join("a.md").exists());
    let root=fs::read_dir(dir.path().join(".noto-webdav")).unwrap().flatten().find(|e|e.file_type().unwrap().is_dir()).unwrap().path();let backups=fs::read_dir(root.join("backups/a.md")).unwrap().flatten().collect::<Vec<_>>();assert_eq!(fs::read(backups[0].path()).unwrap(),b"original");
    assert!(run(&v,&d).conflicts.is_empty());
}
#[test]
fn remote_racing_write_and_nonconforming_servers_are_never_force_overwritten(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();let note=v.create_note("a.md","base").unwrap();run(&v,&d);
    v.save_note("a.md","local change",&note.version).unwrap();d.model.lock().unwrap().race_put=Some(("/dav/Noto/a.md".into(),b"concurrent remote".to_vec()));
    let r=run(&v,&d);assert_eq!(r.errors.len(),1);assert_eq!(d.model.lock().unwrap().files["/dav/Noto/a.md"].0,b"concurrent remote");
    assert_eq!(v.read_note("a.md").unwrap().content,"local change");
    for weak in [false,true]{let d=support::DavFixture::new();{let mut m=d.model.lock().unwrap();m.weak=weak;m.ignore_conditions=!weak;}
        let r=run(&v,&d);assert!(!r.errors.is_empty());assert!(!d.model.lock().unwrap().files.contains_key("/dav/Noto/a.md"));}
}
#[test]
fn interrupted_upload_retries_and_bad_documents_do_not_replace_valid_local_files(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();v.create_note("a.md","base").unwrap();d.model.lock().unwrap().fail_put=Some("/dav/Noto/a.md".into());
    assert_eq!(run(&v,&d).errors.len(),1);assert_eq!(run(&v,&d).uploaded,1);
    fs::write(dir.path().join("map.canvas"),b"{\"nodes\":[],\"edges\":[]}").unwrap();run(&v,&d);d.model.lock().unwrap().put("/dav/Noto/map.canvas",b"broken");assert_eq!(run(&v,&d).errors.len(),1);assert_eq!(fs::read(dir.path().join("map.canvas")).unwrap(),b"{\"nodes\":[],\"edges\":[]}");
}
#[test]
fn malicious_listing_corrupt_state_and_case_aliases_stop_before_writes(){
    for href in ["/dav/Noto/../escape.md","/dav/Noto/%2e%2e/escape.md","http://other.invalid/a.md","/dav/Noto/%2Fescape.md"]{
        let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();d.model.lock().unwrap().listing_override=Some(format!("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{href}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"));assert!(v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![]}).is_err());assert!(v.list().unwrap().is_empty());
    }
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();d.model.lock().unwrap().put("/dav/Noto/a.md","a");d.model.lock().unwrap().put("/dav/Noto/A.md","b");assert!(v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![]}).unwrap_err().contains("大小写"));
    d.model.lock().unwrap().files.clear();run(&v,&d);let state=fs::read_dir(dir.path().join(".noto-webdav")).unwrap().flatten().find(|e|e.file_type().unwrap().is_dir()).unwrap().path().join("baseline.json");fs::write(state,"broken").unwrap();let count=d.model.lock().unwrap().calls.len();assert!(v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![]}).unwrap_err().contains("损坏"));assert_eq!(d.model.lock().unwrap().calls.len(),count);
}
#[test]
fn local_deletion_requires_confirmation_and_large_files_never_replace_remote(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();v.create_note("a.md","base").unwrap();run(&v,&d);fs::remove_file(dir.path().join("a.md")).unwrap();
    let c=run(&v,&d).conflicts.remove(0);assert!(!dir.path().join("a.md").exists());assert!(d.model.lock().unwrap().files.contains_key("/dav/Noto/a.md"));
    let report=v.sync_webdav(WebDavSync{config:config(&d),protected_paths:vec![],resolutions:vec![Resolution{path:c.path,local_version:c.local_version,remote_version:c.remote_version,choice:Choice::Local}]}).unwrap();assert_eq!(report.deleted_remote,1);
    fs::File::create(dir.path().join("large.bin")).unwrap().set_len(64*1024*1024+1).unwrap();let r=run(&v,&d);assert_eq!(r.errors.len(),1);assert!(!d.model.lock().unwrap().files.contains_key("/dav/Noto/large.bin"));
}
#[test]
fn lost_write_response_is_reconciled_and_unwritable_backup_blocks_replacement(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();v.create_note("a.md","original").unwrap();d.model.lock().unwrap().lost_put=Some("/dav/Noto/a.md".into());
    assert_eq!(run(&v,&d).errors.len(),1);let report=run(&v,&d);assert!(report.errors.is_empty());assert_eq!(report.uploaded+report.downloaded,0);
    let root=fs::read_dir(dir.path().join(".noto-webdav")).unwrap().flatten().find(|e|e.file_type().unwrap().is_dir()).unwrap().path();fs::write(root.join("backups"),b"blocked").unwrap();d.model.lock().unwrap().put("/dav/Noto/a.md","remote update");
    assert_eq!(run(&v,&d).errors.len(),1);assert_eq!(v.read_note("a.md").unwrap().content,"original");
}
#[cfg(unix)]
#[test]
fn symlink_targets_and_reserved_internal_paths_cannot_escape(){
    let d=support::DavFixture::new();let dir=tempfile::tempdir().unwrap();let outside=tempfile::tempdir().unwrap();let v=Vault::open(dir.path()).unwrap();fs::write(outside.path().join("a.md"),"outside").unwrap();std::os::unix::fs::symlink(outside.path(),dir.path().join("link")).unwrap();d.model.lock().unwrap().put("/dav/Noto/link/a.md","remote");assert!(!run(&v,&d).errors.is_empty());assert_eq!(fs::read_to_string(outside.path().join("a.md")).unwrap(),"outside");assert!(v.create_note(".noto-webdav/x.md","bad").is_err());
}
