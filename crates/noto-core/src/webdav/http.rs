use super::*;
use reqwest::{blocking::{Client,RequestBuilder,Response},header,Method,Url};
use quick_xml::{Reader,events::Event};
use std::{io::Read,sync::atomic::{AtomicU64,Ordering},time::{SystemTime,UNIX_EPOCH}};
const XML:&str=r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;
pub(super) struct Dav {client:Client,service:Url,root:Url,username:String,password:String,deadline:Instant}
pub(super) struct Remote {pub etag:Option<String>}
pub(super) struct Content {pub bytes:Vec<u8>,pub etag:Option<String>}
#[derive(Default)]
struct Entry {href:String,collection:bool,etag:Option<String>}
fn strong(etag:&str)->Option<String>{(etag.len()>=2&&etag.len()<=512&&etag.starts_with('"')&&etag.ends_with('"')&&!etag.starts_with("W/")&&!etag.contains(['\r','\n'])).then(||etag.to_owned())}
fn parts(url:&Url)->Result<Vec<String>,String>{
    url.path().trim_matches('/').split('/').filter(|s|!s.is_empty()).map(|s|{
        let decoded=percent_encoding::percent_decode_str(s).decode_utf8().map_err(|_|"远端路径编码无效")?.into_owned();
        if decoded=="."||decoded==".."||decoded.contains(['/','\\']){return Err("远端路径包含越界片段".into());}Ok(decoded)
    }).collect()
}
fn parse(xml:&str)->Result<Vec<Entry>,String>{
    let mut reader=Reader::from_str(xml);let mut stack=Vec::new();let mut entries=Vec::new();let mut current=Entry::default();
    let mut props=Entry::default();let mut status=String::new();let mut good=false;let mut root=false;
    loop{
        let event=reader.read_event().map_err(|_|"WebDAV 返回了损坏的 XML，未继续同步")?;
        let empty=matches!(&event,Event::Empty(_));
        match event{
            Event::Start(e)|Event::Empty(e)=>{
                let name=e.name().local_name().as_ref().to_ascii_lowercase();
                if stack.is_empty(){if root||name!="multistatus"{return Err("WebDAV 未返回有效的目录列表".into());}root=true;}
                if stack.len()>32{return Err("WebDAV XML 嵌套过深".into());}
                if name=="response" {current=Entry::default();good=false;}
                if name=="propstat"{props=Entry::default();status.clear();}
                if name=="collection"&&stack.last().is_some_and(|v|v=="resourcetype"){props.collection=true;}
                if !empty{stack.push(name);}
            },
            Event::Text(e)=>{
                let text:&str=&e;
                match stack.last().map(String::as_str){Some("href")=>current.href.push_str(text),Some("getetag")=>props.etag.get_or_insert_with(String::new).push_str(text),Some("status")=>status.push_str(text),_=>()}
            },
            Event::CData(e)=>{let text:&str=&e;match stack.last().map(String::as_str){Some("href")=>current.href.push_str(text),Some("getetag")=>props.etag.get_or_insert_with(String::new).push_str(text),_=>()}},
            Event::GeneralRef(e)=>{
                let c=e.resolve_char_ref().map_err(|_|"WebDAV XML 字符引用无效")?.or_else(||match &*e{"amp"=>Some('&'),"lt"=>Some('<'),"gt"=>Some('>'),"quot"=>Some('"'),"apos"=>Some('\''),_=>None}).ok_or("WebDAV XML 实体不支持")?;
                match stack.last().map(String::as_str){Some("href")=>current.href.push(c),Some("getetag")=>props.etag.get_or_insert_with(String::new).push(c),_=>return Err("WebDAV XML 引用位置无效".into())}
            },
            Event::End(e)=>{
                let name=e.name().local_name().as_ref().to_ascii_lowercase();
                if stack.pop().as_deref()!=Some(&name){return Err("WebDAV XML 结构无效".into());}
                if name=="propstat"&&status.split_whitespace().nth(1).is_some_and(|v|v.starts_with('2')){good=true;current.collection|=props.collection;if props.etag.is_some(){current.etag=props.etag.take();}}
                if name=="response"{
                    if !good||current.href.trim().is_empty(){return Err("WebDAV 目录条目缺少成功状态或路径".into());}
                    entries.push(std::mem::take(&mut current));if entries.len()>MAX_FILES+1{return Err("WebDAV 目录条目过多".into());}
                }
            },
            Event::Decl(_)|Event::Comment(_)=>(),Event::Eof=>break,_=>return Err("WebDAV XML 含不支持的内容".into())
        }
    }
    if !root||!stack.is_empty()||entries.is_empty(){return Err("WebDAV 目录响应不完整，未继续同步".into());}Ok(entries)
}
impl Dav {
    pub fn new(cfg:&WebDavConfig)->Result<Self,String>{
        if cfg.url.len()>4096||cfg.username.len()>512||cfg.password.len()>4096{return Err("WebDAV 配置过长".into());}
        let mut service=Url::parse(cfg.url.trim()).map_err(|_|"请输入完整的 WebDAV HTTP/HTTPS 服务地址")?;
        if !["http","https"].contains(&service.scheme())||service.host_str().is_none()||!service.username().is_empty()||service.password().is_some()||service.query().is_some()||service.fragment().is_some(){return Err("WebDAV 地址只能使用 HTTP/HTTPS，账号密码请分别填写，不能包含查询或锚点".into());}
        let path=cfg.remote_path.trim_matches('/');visible(path)?;
        if !service.path().ends_with('/'){service.set_path(&format!("{}/",service.path()));}
        parts(&service)?;
        let mut root=service.clone();{let mut p=root.path_segments_mut().map_err(|_|"WebDAV 地址无效")?;p.pop_if_empty();for s in path.split('/'){p.push(s);}p.push("");}
        let client=Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(30)).build().map_err(|_|"无法创建 WebDAV 网络连接")?;
        Ok(Self{client,service,root,username:cfg.username.clone(),password:cfg.password.clone(),deadline:Instant::now()+Duration::from_secs(300)})
    }
    pub fn identity(&self)->String{format!("{}\n{}",self.root,self.username)}
    pub fn expired(&self)->bool{Instant::now()>=self.deadline}
    fn request(&self,method:Method,url:Url)->RequestBuilder{self.client.request(method,url).basic_auth(&self.username,Some(&self.password)).header(header::ACCEPT_ENCODING,"identity").header(header::USER_AGENT,"Noto-WebDAV/1")}
    fn send(&self,request:RequestBuilder)->Result<Response,String>{
        let remaining=self.deadline.checked_duration_since(Instant::now()).ok_or("本轮同步达到 5 分钟上限，请检查网络后重试")?;
        request.timeout(remaining.min(Duration::from_secs(30))).send().map_err(|e|if e.is_timeout(){"WebDAV 请求超时；已完成的操作会在下次同步重新核对".into()}else{"WebDAV 网络或证书连接失败，请检查地址和网络".into()})
    }
    fn status(response:&Response)->Result<(),String>{
        if response.status().is_success(){return Ok(());}
        Err(match response.status().as_u16(){401|403=>"WebDAV 认证失败或没有权限".into(),412=>"远端文件在同步期间变化，条件写入已停止；请重新同步".into(),301|302|307|308=>"WebDAV 地址发生重定向，请填写最终服务地址".into(),v=>format!("WebDAV 请求失败（HTTP {v}）")})
    }
    fn bytes(response:Response,limit:usize)->Result<Vec<u8>,String>{
        Self::status(&response)?;if response.content_length().is_some_and(|n|n>limit as u64){return Err("WebDAV 响应超过容量上限".into());}
        let mut bytes=Vec::new();response.take(limit as u64+1).read_to_end(&mut bytes).map_err(|_|"WebDAV 响应读取中断，未覆盖原文件")?;
        if bytes.len()>limit{return Err("WebDAV 响应超过容量上限".into());}Ok(bytes)
    }
    fn url(&self,path:&str)->Result<Url,String>{visible(path)?;let mut url=self.root.clone();{let mut parts=url.path_segments_mut().map_err(|_|"WebDAV 地址无效")?;parts.pop_if_empty();for s in path.split('/'){parts.push(s);}}Ok(url)}
    fn propfind(&self,url:Url,depth:u8)->Result<Vec<Entry>,String>{
        let r=self.send(self.request(Method::from_bytes(b"PROPFIND").unwrap(),url).header("Depth",depth.to_string()).header(header::CONTENT_TYPE,"application/xml; charset=utf-8").body(XML))?;
        if r.status().as_u16()!=207{Self::status(&r)?;return Err("WebDAV PROPFIND 没有返回 207 目录响应".into());}
        let bytes=Self::bytes(r,8*1024*1024)?;parse(std::str::from_utf8(&bytes).map_err(|_|"WebDAV 目录不是 UTF-8")?)
    }
    fn child(&self,parent:&Url,href:&str)->Result<(Url,String,bool),String>{
        for s in href.trim().split('/') {let d=percent_encoding::percent_decode_str(s).decode_utf8().map_err(|_|"远端路径编码无效")?;if d=="."||d==".."||d.contains(['\\'])||d.contains('/') {return Err("WebDAV 返回了越界路径".into());}}
        let url=parent.join(href.trim()).map_err(|_|"远端路径无效")?;
        if url.origin()!=self.root.origin()||!url.username().is_empty()||url.password().is_some()||url.query().is_some()||url.fragment().is_some(){return Err("WebDAV 返回了其他服务或不安全路径".into());}
        let root=parts(&self.root)?;let current=parts(parent)?;let target=parts(&url)?;
        if !target.starts_with(&root)||!target.starts_with(&current)||target.len()>current.len()+1{return Err("WebDAV 返回了目录范围之外的路径".into());}
        let rel=target[root.len()..].join("/");let same=target==current;
        Ok((url,rel,same))
    }
    pub fn test(&self)->Result<(),String>{
        let entries=self.propfind(self.service.clone(),0)?;
        let expected=parts(&self.service)?;
        if !entries.iter().any(|e|e.collection&&self.service.join(&e.href).ok().is_some_and(|u|u.origin()==self.service.origin()&&parts(&u).ok()==Some(expected.clone()))){return Err("服务地址不是 WebDAV 目录".into());}Ok(())
    }
    pub fn ensure_root(&self)->Result<(),String>{
        self.test()?;let service=parts(&self.service)?;let root=parts(&self.root)?;let mut url=self.service.clone();
        for part in &root[service.len()..]{
            {let mut p=url.path_segments_mut().map_err(|_|"WebDAV 目录地址无效")?;p.pop_if_empty();p.push(part);p.push("");}
            let response=self.send(self.request(Method::from_bytes(b"MKCOL").unwrap(),url.clone()))?;
            if ![201,405].contains(&response.status().as_u16()){Self::status(&response)?;return Err("WebDAV 未能创建远端目录".into());}
        }Ok(())
    }
    pub fn list(&self)->Result<BTreeMap<String,Remote>,String>{
        let mut result=BTreeMap::new();let mut stack=vec![self.root.clone()];let mut visited=BTreeSet::new();
        while let Some(url)=stack.pop(){
            if !visited.insert(url.as_str().to_owned())||visited.len()>MAX_FILES{return Err("WebDAV 目录循环或超过数量限制".into());}
            let entries=self.propfind(url.clone(),1)?;let mut self_found=false;
            for e in entries{let (mut child,rel,same)=self.child(&url,&e.href)?;
                if same{if !e.collection{return Err("WebDAV 同步目标不是目录".into());}self_found=true;continue;}
                if rel.split('/').any(|p|p.starts_with('.'))||rel.contains(CONFLICT_MARK){continue;}visible(&rel)?;
                if e.collection{if !child.path().ends_with('/'){child.path_segments_mut().map_err(|_|"远端目录地址无效")?.push("");}stack.push(child);}else if result.insert(rel,Remote{etag:e.etag.and_then(|v|strong(v.trim()))}).is_some(){return Err("WebDAV 返回了重复文件".into());}
                if result.len()>MAX_FILES{return Err("远端超过 10000 个文件".into());}
            }
            if !self_found{return Err("WebDAV 目录响应缺少当前目录，未继续同步".into());}
        }Ok(result)
    }
    pub fn get(&self,path:&str,expected:Option<&str>)->Result<Content,String>{
        let mut request=self.request(Method::GET,self.url(path)?);if let Some(tag)=expected{request=request.header(header::IF_MATCH,tag);}
        let response=self.send(request)?;Self::status(&response)?;
        let etag=response.headers().get(header::ETAG).and_then(|v|v.to_str().ok()).and_then(strong);
        if expected.is_some()&&etag.as_deref()!=expected{return Err("远端版本标识变化，请重新同步".into());}
        Ok(Content{bytes:Self::bytes(response,MAX_FILE)?,etag})
    }
    pub fn put(&self,path:&str,bytes:Vec<u8>,expected:Option<&str>)->Result<(),String>{
        let mut url=self.root.clone();let parts:Vec<_>=path.split('/').collect();
        for part in &parts[..parts.len()-1]{
            {let mut p=url.path_segments_mut().map_err(|_|"WebDAV 地址无效")?;p.pop_if_empty();p.push(part);p.push("");}
            let response=self.send(self.request(Method::from_bytes(b"MKCOL").unwrap(),url.clone()))?;if ![201,405].contains(&response.status().as_u16()){Self::status(&response)?;return Err("WebDAV 创建子目录失败".into());}
        }
        let version=content_version(&bytes);let mut request=self.request(Method::PUT,self.url(path)?).header(header::CONTENT_TYPE,"application/octet-stream").body(bytes);
        request=if let Some(tag)=expected{request.header(header::IF_MATCH,tag)}else{request.header(header::IF_NONE_MATCH,"*")};
        Self::status(&self.send(request)?)?;
        if content_version(&self.get(path,None)?.bytes)!=version{return Err("上传后的远端内容与本次提交不同，请重新同步检查".into());}Ok(())
    }
    pub fn delete(&self,path:&str,expected:&str)->Result<(),String>{Self::status(&self.send(self.request(Method::DELETE,self.url(path)?).header(header::IF_MATCH,expected))?)}
    pub fn check_conditions(&self)->Result<(),String>{
        static COUNTER:AtomicU64=AtomicU64::new(0);
        let nonce=format!("{}-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(),COUNTER.fetch_add(1,Ordering::Relaxed));
        // Kept outside the public file tree, never touches an existing user file.
        let mut url=self.root.clone();url.path_segments_mut().map_err(|_|"WebDAV 地址无效")?.pop_if_empty().push(&format!(".noto-probe-{nonce}"));
        Self::status(&self.send(self.request(Method::PUT,url.clone()).header(header::IF_NONE_MATCH,"*").body("Noto conditional request probe"))?)?;
        let response=self.send(self.request(Method::GET,url.clone()))?;Self::status(&response)?;
        let tag=response.headers().get(header::ETAG).and_then(|v|v.to_str().ok()).and_then(strong).ok_or("服务器未提供强 ETag，不能保证安全覆盖；请使用支持条件请求的 WebDAV 服务")?;
        let mut supported=true;
        for (method,name,value) in [(Method::PUT,header::IF_MATCH,format!("\"noto-absent-{nonce}\"")),(Method::PUT,header::IF_NONE_MATCH,"*".into()),(Method::DELETE,header::IF_MATCH,format!("\"noto-absent-{nonce}\""))]{
            let response=self.send(self.request(method,url.clone()).header(name,value).body("probe"))?;
            if response.status().as_u16()!=412{supported=false;break;}
        }
        // A non-conforming server may have changed/deleted the probe. Clean it
        // only with its current strong ETag; never use an unconditional DELETE.
        let latest=self.send(self.request(Method::GET,url.clone()))?;
        if latest.status().is_success(){if let Some(current)=latest.headers().get(header::ETAG).and_then(|v|v.to_str().ok()).and_then(strong){let _=self.send(self.request(Method::DELETE,url).header(header::IF_MATCH,current));}}
        let _=tag;
        if !supported{return Err("服务器未正确执行条件写入，已停止上传/删除，用户文件未被强制覆盖".into());}Ok(())
    }
}
