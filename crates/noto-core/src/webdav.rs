//! Manual, content-based WebDAV synchronization. Never merge or force overwrites.
use crate::{content_version, Vault};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet}, time::{Duration, Instant}};
mod files;
mod http;
pub(crate) const STATE_DIR: &str = ".noto-webdav";
const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 10000;
const CONFLICT_MARK: &str = " (WebDAV 冲突 ";

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct WebDavConfig { pub url:String, pub username:String, pub password:String, pub remote_path:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct WebDavSync {
    pub config:WebDavConfig,
    #[serde(default)] pub protected_paths:Vec<String>,
    #[serde(default)] pub resolutions:Vec<Resolution>,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Resolution { pub path:String, pub local_version:Option<String>, pub remote_version:Option<String>, pub choice:Choice }
#[derive(Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Choice { Local, Remote }
#[derive(Default, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct WebDavReport {
    pub uploaded:usize, pub downloaded:usize, pub deleted_local:usize, pub deleted_remote:usize,
    pub conflicts:Vec<SyncConflict>, pub skipped:Vec<String>, pub errors:Vec<SyncIssue>, pub changed:Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SyncConflict {pub path:String,pub reason:String,pub local_version:Option<String>,pub remote_version:Option<String>,pub copy:Option<String>}
#[derive(Debug, Serialize)]
pub struct SyncIssue {pub path:String,pub message:String}
#[derive(Default, Deserialize, Serialize)]
struct Baseline {schema:u8, files:BTreeMap<String,String>}
fn visible(path:&str)->Result<(),String> {
    crate::operations::validate_relative(path).map_err(|e|e.to_string())?;
    for part in path.split('/') {
        let stem=part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.starts_with('.')||part.ends_with(['.',' '])||part.contains(['*','?','"','<','>','|'])
            || ["CON","PRN","AUX","NUL"].contains(&stem.as_str())
            || stem.len()==4&&(stem.starts_with("COM")||stem.starts_with("LPT"))&&stem.as_bytes()[3].is_ascii_digit() {
            return Err("同步路径包含隐藏项或不兼容的文件名".into());
        }
    }
    if path.len()>1024||path.split('/').count()>32{return Err("同步路径过长".into());}Ok(())
}
fn hash(bytes:Option<&Vec<u8>>)->Option<String>{bytes.map(|v|content_version(v))}
pub fn test_connection(config:WebDavConfig)->Result<(),String>{http::Dav::new(&config)?.test()}
impl Vault {
    pub fn sync_webdav(&self,input:WebDavSync)->Result<WebDavReport,String>{
        if input.protected_paths.len()>MAX_FILES||input.resolutions.len()>MAX_FILES{return Err("同步参数超过 10000 项上限".into());}
        for path in &input.protected_paths{visible(path)?;}
        let dav=http::Dav::new(&input.config)?;
        let store=files::Store::open(self,&dav.identity())?;
        let _sync_lock=store.lock()?;
        let mut base=store.load()?;
        dav.ensure_root()?;
        let remote=dav.list()?;
        let local=self.sync_paths()?;
        let paths:BTreeSet<_>=local.into_iter().chain(remote.keys().cloned()).chain(base.files.keys().cloned()).collect();
        if paths.len()>MAX_FILES{return Err("单次同步最多 10000 个文件，请缩小远端目录".into());}
        let mut folded=BTreeSet::new();
        for path in &paths{visible(path)?;if !folded.insert(path.to_lowercase()){return Err("存在仅大小写不同的文件，请先改名，避免跨平台覆盖".into());}}
        let mut resolutions=BTreeMap::new();
        for r in input.resolutions {visible(&r.path)?;if resolutions.insert(r.path.clone(),r).is_some(){return Err("同一文件不能重复选择冲突处理方式".into());}}
        let protected:BTreeSet<_>=input.protected_paths.into_iter().collect();
        let mut report=WebDavReport::default();let mut checked_write=false;
        for path in paths {
            if dav.expired(){report.errors.push(SyncIssue{path,message:"本轮同步达到 5 分钟上限，请检查网络后重试；已完成的文件会重新核对".into()});break;}
            if protected.contains(&path){report.skipped.push(path);continue;}
            let work=(||->Result<(),String>{
                let l=self.sync_read(&path)?;
                let r=if let Some(meta)=remote.get(&path){Some(dav.get(&path,meta.etag.as_deref())?)}else{None};
                let lv=hash(l.as_ref());let rv=r.as_ref().map(|r|content_version(&r.bytes));
                if lv==rv {if let Some(v)=lv{base.files.insert(path.clone(),v);}else{base.files.remove(&path);}return Ok(());}
                let previous=base.files.get(&path);
                let chosen=resolutions.get(&path);
                let direction=if let Some(choice)=chosen {
                    if lv!=choice.local_version||rv!=choice.remote_version{return Err("冲突版本已变化，请重新同步并检查后再选择".into());}
                    Some(matches!(choice.choice,Choice::Local))
                }else if previous.is_some()&&(lv.is_none()||rv.is_none()){None}
                else if previous.is_none()&&lv.is_none(){Some(false)}
                else if previous.is_none()&&rv.is_none(){Some(true)}
                else if lv.as_ref()==previous{Some(false)}else if rv.as_ref()==previous{Some(true)}else{None};
                let Some(push)=direction else {
                    let copy=if let Some(r)=&r {Some(self.sync_conflict_copy(&path,&r.bytes)?)}else{None};
                    if let Some(copy)=&copy {report.changed.push(copy.clone());}
                    report.conflicts.push(SyncConflict{path:path.clone(),reason:if lv.is_none()||rv.is_none(){"一端删除了文件，需确认保留哪一端"}else{"双方内容不同，原文件未覆盖；远端内容已有本地冲突副本"}.into(),local_version:lv,remote_version:rv,copy});
                    return Ok(());
                };
                if push {
                    if r.as_ref().is_some_and(|r|r.etag.is_none()){return Err("远端文件没有强 ETag，不能安全覆盖或删除".into());}
                    // Verify conditional requests on our own disposable resource first.
                    if !checked_write{dav.check_conditions()?;checked_write=true;}
                    // Recheck the source after network reads; a later local save remains a new change.
                    if hash(self.sync_read(&path)?.as_ref())!=lv{return Err("本地文件在同步期间变化，已跳过".into());}
                    if let Some(bytes)=l {dav.put(&path,bytes,r.as_ref().and_then(|v|v.etag.as_deref()))?;report.uploaded+=1;}
                    else {dav.delete(&path,r.as_ref().and_then(|v|v.etag.as_deref()).ok_or("远端没有强 ETag，不能安全删除")?)?;report.deleted_remote+=1;}
                    if let Some(v)=lv{base.files.insert(path.clone(),v);}else{base.files.remove(&path);}
                }else{
                    self.sync_replace(&path,r.as_ref().map(|v|v.bytes.as_slice()),lv.as_deref(),&store)?;
                    if let Some(v)=rv{base.files.insert(path.clone(),v);report.downloaded+=1;}else{base.files.remove(&path);report.deleted_local+=1;}
                    report.changed.push(path.clone());
                }
                Ok(())
            })();
            if let Err(message)=work{report.errors.push(SyncIssue{path,message});}
            if dav.expired()||report.errors.len()>=20{break;}
        }
        store.save(&base)?;Ok(report)
    }
}
