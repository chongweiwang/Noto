use super::*;
use atomicwrites::{AllowOverwrite,AtomicFile,DisallowOverwrite};
use std::{fs,io::{Read,Write},path::{Path,PathBuf}};
fn plain_dir(path:&Path)->Result<(),String>{
    match fs::create_dir(path){Ok(())=>(),Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>(),Err(e)=>return Err(e.to_string())}
    let m=fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if !m.is_dir()||m.file_type().is_symlink(){return Err("同步数据目录不是普通目录，请保留原数据并检查".into());}Ok(())
}
pub(super) struct Store {dir:PathBuf}
impl Store {
    pub fn open(vault:&Vault,identity:&str)->Result<Self,String>{
        let root=vault.root.join(STATE_DIR);plain_dir(&root)?;
        let dir=root.join(content_version(identity.as_bytes()).trim_start_matches("sha256-"));plain_dir(&dir)?;
        Ok(Self{dir})
    }
    pub fn lock(&self)->Result<fs::File,String>{
        let path=self.dir.parent().unwrap().join("sync.lock");
        if let Ok(m)=fs::symlink_metadata(&path){if !m.is_file()||m.file_type().is_symlink(){return Err("同步锁路径无效".into());}}
        let f=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|e|e.to_string())?;
        f.try_lock().map_err(|_|"这个知识库已有 WebDAV 同步正在进行".to_owned())?;Ok(f)
    }
    fn state_path(&self)->Result<PathBuf,String>{
        let path=self.dir.join("baseline.json");
        if let Ok(m)=fs::symlink_metadata(&path){if !m.is_file()||m.file_type().is_symlink(){return Err("同步基准路径无效".into());}}Ok(path)
    }
    pub fn load(&self)->Result<Baseline,String>{
        let path=self.state_path()?;
        let mut bytes=Vec::new();match fs::File::open(&path){Ok(f)=>{f.take(8*1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(Baseline{schema:1,..Default::default()}),Err(e)=>return Err(e.to_string())};
        if bytes.len()>8*1024*1024{return Err("同步基准超过容量限制，请保留原文件".into());}
        let value:Baseline=serde_json::from_slice(&bytes).map_err(|_|"同步基准损坏，请保留原文件；未执行同步".to_owned())?;
        if value.schema!=1||value.files.len()>MAX_FILES{return Err("同步基准格式不支持，未执行同步".into());}
        for (path,hash) in &value.files{visible(path)?;if hash.len()!=71||!hash.starts_with("sha256-")||!hash[7..].bytes().all(|b|b.is_ascii_hexdigit()){return Err("同步基准内容损坏".into());}}
        Ok(value)
    }
    pub fn save(&self,state:&Baseline)->Result<(),String>{
        let bytes=serde_json::to_vec(state).map_err(|e|e.to_string())?;
        AtomicFile::new(&self.state_path()?,AllowOverwrite).write(|f|{f.write_all(&bytes)?;f.sync_all()}).map_err(|e|format!("同步基准未能保存，请重试：{e}"))
    }
    fn backup_folder(&self,path:&str)->Result<PathBuf,String>{
        let mut dir=self.dir.join("backups");plain_dir(&dir)?;
        for part in path.split('/') {dir.push(part);plain_dir(&dir)?;}Ok(dir)
    }
    fn backup(&self,path:&str,bytes:&[u8])->Result<(),String>{
        let dir=self.backup_folder(path)?;let target=dir.join(content_version(bytes));
        match fs::symlink_metadata(&target){
            Ok(m) if m.is_file()&&!m.file_type().is_symlink()=>{if m.len()!=bytes.len() as u64||fs::read(&target).map_err(|e|e.to_string())?!=bytes{return Err("同步备份损坏，已停止覆盖原文件".into());}return Ok(());},
            Ok(_)=>return Err("同步备份路径无效".into()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),Err(e)=>return Err(e.to_string())
        }
        AtomicFile::new(&target,DisallowOverwrite).write(|f|{f.write_all(bytes)?;f.sync_all()}).map_err(|e|format!("无法保护旧文件，未覆盖：{e}"))
    }
    fn prune(&self,path:&str,keep:Option<&str>){
        // Only our exact hash-named regular backup files; keep the newest three.
        let Ok(dir)=self.backup_folder(path) else{return;};let Ok(entries)=fs::read_dir(&dir) else{return;};
        let mut entries:Vec<_>=entries.flatten().filter_map(|e|{let name=e.file_name().to_str()?.to_owned();let m=fs::symlink_metadata(e.path()).ok()?;
            (m.is_file()&&!m.file_type().is_symlink()&&name.len()==71&&name.starts_with("sha256-")&&name[7..].bytes().all(|b|b.is_ascii_hexdigit())).then_some((m.modified().ok()?,e.path()))}).collect();
        entries.sort_by(|a,b|{
            let protected=|p:&PathBuf|p.file_name().and_then(|v|v.to_str())==keep;
            protected(&b.1).cmp(&protected(&a.1)).then_with(||b.0.cmp(&a.0))
        });for (_,path) in entries.into_iter().skip(3){let _=fs::remove_file(path);}
    }
}
impl Vault {
    fn sync_target(&self,path:&str,create:bool)->Result<PathBuf,String>{
        visible(path)?;let mut current=self.root.clone();let parts:Vec<_>=path.split('/').collect();
        for (index,part) in parts.iter().enumerate(){
            current.push(part);let last=index+1==parts.len();
            if create&&!last {plain_dir(&current)?;}
            match fs::symlink_metadata(&current){
                Ok(m) if m.file_type().is_symlink()||!last&&!m.is_dir()||last&&!m.is_file()=>return Err("同步路径包含符号链接或文件/目录冲突".into()),
                Ok(_)=>(),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),Err(e)=>return Err(e.to_string())
            }
        }Ok(current)
    }
    fn sync_read_inner(&self,path:&str)->Result<Option<Vec<u8>>,String>{
        let target=self.sync_target(path,false)?;
        let f=match fs::File::open(target){Ok(f)=>f,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(e)=>return Err(e.to_string())};
        if f.metadata().map_err(|e|e.to_string())?.len()>MAX_FILE as u64{return Err("文件超过 64 MiB 同步上限".into());}
        let mut bytes=Vec::new();f.take(MAX_FILE as u64+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
        if bytes.len()>MAX_FILE{return Err("文件超过 64 MiB 同步上限".into());}Ok(Some(bytes))
    }
    pub(super) fn sync_read(&self,path:&str)->Result<Option<Vec<u8>>,String>{
        let _guard=self.writes.lock().map_err(|_|"文件锁异常".to_owned())?;self.sync_read_inner(path)
    }
    pub(super) fn sync_paths(&self)->Result<Vec<String>,String>{
        fn visit(entries:Vec<crate::VaultEntry>,out:&mut Vec<String>)->Result<(),String>{
            for e in entries {if let Some(issue)=e.issue{return Err(format!("{}：{}",e.path,issue));}
                if e.is_directory{visit(e.children,out)?;}else if !e.name.contains(CONFLICT_MARK){visible(&e.path)?;out.push(e.path);}
                if out.len()>MAX_FILES{return Err("单次同步最多 10000 个文件".into());}
            }Ok(())
        }
        let mut out=vec![];visit(self.list().map_err(|e|e.to_string())?,&mut out)?;Ok(out)
    }
    pub(super) fn sync_replace(&self,path:&str,bytes:Option<&[u8]>,expected:Option<&str>,store:&Store)->Result<(),String>{
        let _guard=self.lock_writes().map_err(|e|e.to_string())?;
        let old=self.sync_read_inner(path)?;
        if hash(old.as_ref()).as_deref()!=expected{return Err("本地文件在同步期间变化，原文件未覆盖".into());}
        let target=self.sync_target(path,bytes.is_some())?;
        if let Some(bytes)=bytes{if crate::is_document_path(&target){
            let text=std::str::from_utf8(bytes).map_err(|_|"远端文档不是有效 UTF-8，未覆盖本地".to_owned())?;
            crate::check_document_write(&target,text.trim_start_matches('\u{feff}')).map_err(|e|e.to_string())?;
        }}
        if let Some(old)=&old{
            store.backup(path,old)?;
            if target.extension().and_then(|e|e.to_str()).is_some_and(|e|e.eq_ignore_ascii_case("md")||e.eq_ignore_ascii_case("markdown"))&&old.len()<=crate::MAX_SNAPSHOT_BYTES{self.record_history(path,old,true).map_err(|e|e.to_string())?;}
        }
        if hash(self.sync_read_inner(path)?.as_ref()).as_deref()!=expected{return Err("本地文件在创建备份期间变化，原文件未覆盖".into());}
        if let Some(bytes)=bytes{
            let permissions=fs::metadata(&target).ok().map(|m|m.permissions());
            let replace=AtomicFile::new(&target,if old.is_some(){AllowOverwrite}else{DisallowOverwrite});
            replace.write(|f|{f.write_all(bytes)?;if let Some(p)=permissions {f.set_permissions(p)?;}f.sync_all()}).map_err(|e|e.to_string())?;
        }else if old.is_some(){fs::remove_file(target).map_err(|e|e.to_string())?;}
        if old.is_some(){store.prune(path,hash(old.as_ref()).as_deref());}Ok(())
    }
    pub(super) fn sync_conflict_copy(&self,path:&str,bytes:&[u8])->Result<String,String>{
        let _guard=self.lock_writes().map_err(|e|e.to_string())?;
        let p=Path::new(path);let stem=p.file_stem().and_then(|v|v.to_str()).ok_or("冲突文件名无效")?;
        let ext=p.extension().and_then(|v|v.to_str()).map(|v|format!(".{v}")).unwrap_or_default();
        let digest=content_version(bytes);let parent=p.parent().unwrap_or(Path::new(""));
        for i in 0..100 {
            let suffix=if i==0{String::new()}else{format!("-{i}")};
            let name=format!("{stem}{CONFLICT_MARK}{}{suffix}){ext}",&digest[7..19]);
            let relative=parent.join(name).components().map(|c|c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            if let Some(previous)=self.sync_read_inner(&relative)?{if previous==bytes{return Ok(relative);}continue;}
            let target=self.sync_target(&relative,true)?;
            AtomicFile::new(&target,DisallowOverwrite).write(|f|{f.write_all(bytes)?;f.sync_all()}).map_err(|e|e.to_string())?;return Ok(relative);
        }Err("冲突副本同名数量过多，请整理后重试".into())
    }
}
