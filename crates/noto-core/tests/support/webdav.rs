#![allow(dead_code)]
use std::{collections::{BTreeMap,BTreeSet},io::{BufRead,BufReader,Read,Write},net::{TcpListener,TcpStream},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread,time::Duration};
pub struct Model {
    pub files:BTreeMap<String,(Vec<u8>,u64)>,pub dirs:BTreeSet<String>,pub calls:Vec<(String,String,BTreeMap<String,String>)>,
    pub weak:bool,pub ignore_conditions:bool,pub race_put:Option<(String,Vec<u8>)>,pub on_get:Option<Arc<dyn Fn(&str)+Send+Sync>>,pub listing_override:Option<String>,pub fail_put:Option<String>,pub lost_put:Option<String>,revision:u64,
}
impl Model {
    pub fn put(&mut self,path:&str,bytes:impl AsRef<[u8]>){self.revision+=1;self.files.insert(path.into(),(bytes.as_ref().to_vec(),self.revision));let parts:Vec<_>=path.trim_start_matches('/').split('/').collect();let mut parent="/".to_owned();for p in &parts[..parts.len()-1]{parent.push_str(p);parent.push('/');self.dirs.insert(parent.clone());}}
}
pub struct DavFixture {pub model:Arc<Mutex<Model>>,pub url:String,stop:Arc<AtomicBool>,handle:Option<thread::JoinHandle<()>>}
pub fn encode(path:&str)->String {path.as_bytes().iter().map(|b|if b.is_ascii_alphanumeric()||b"/-._~".contains(b){(*b as char).to_string()}else{format!("%{b:02X}")}).collect()}
fn decode(path:&str)->String{let b=path.as_bytes();let mut out=vec![];let mut i=0;while i<b.len(){if b[i]==b'%'&&i+2<b.len(){out.push(u8::from_str_radix(std::str::from_utf8(&b[i+1..i+3]).unwrap(),16).unwrap());i+=3;}else{out.push(b[i]);i+=1;}}String::from_utf8(out).unwrap()}
fn escape(value:&str)->String{value.replace('&',"&amp;").replace('"',"&quot;").replace('<',"&lt;")}
fn xml_entry(path:&str,dir:bool,tag:Option<u64>)->String{format!("<d:response><d:href>{}</d:href><d:propstat><d:prop><d:resourcetype>{}</d:resourcetype>{}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",escape(&encode(path)),if dir{"<d:collection/>"}else{""},tag.map(|t|format!("<d:getetag>&quot;v{t}&quot;</d:getetag>")).unwrap_or_default())}
impl DavFixture {
    pub fn new()->Self{
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();listener.set_nonblocking(true).unwrap();
        let model=Arc::new(Mutex::new(Model{files:BTreeMap::new(),dirs:["/".into(),"/dav/".into(),"/dav/Noto/".into()].into(),calls:vec![],weak:false,ignore_conditions:false,race_put:None,on_get:None,listing_override:None,fail_put:None,lost_put:None,revision:0}));
        let stop=Arc::new(AtomicBool::new(false));let shared=model.clone();let ended=stop.clone();
        let handle=thread::spawn(move||{while !ended.load(Ordering::SeqCst){match listener.accept(){Ok((mut stream,_))=>{stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();if let Err(e)=serve(&mut stream,&shared){eprintln!("WebDAV test fixture IO: {e}");}},Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(1)),Err(_)=>break}}});
        Self{model,url:format!("http://{address}/dav/"),stop,handle:Some(handle)}
    }
}
impl Drop for DavFixture{fn drop(&mut self){self.stop.store(true,Ordering::SeqCst);if let Some(handle)=self.handle.take(){handle.join().unwrap();}}}
fn serve(stream:&mut TcpStream,shared:&Arc<Mutex<Model>>)->std::io::Result<()>{
    let mut read=BufReader::new(stream.try_clone()?);let mut line=String::new();if read.read_line(&mut line)?==0{return Ok(());}
    let request:Vec<_>=line.trim().split_whitespace().map(str::to_owned).collect();if request.len()<2{return Ok(());}
    let method=request[0].clone();let path=decode(&request[1]);let mut headers=BTreeMap::new();
    loop{line.clear();read.read_line(&mut line)?;if line=="\r\n"||line.is_empty(){break;}if let Some((k,v))=line.split_once(':'){headers.insert(k.to_ascii_lowercase(),v.trim().to_owned());}}
    let size:usize=headers.get("content-length").and_then(|n|n.parse().ok()).unwrap_or(0);let mut bytes=vec![0;size];read.read_exact(&mut bytes)?;
    let mut m=shared.lock().unwrap();m.calls.push((method.clone(),path.clone(),headers.clone()));
    let mut code=200;let mut body=vec![];let mut extra=String::new();
    if headers.get("authorization").map(String::as_str)!=Some("Basic dXNlcjpwYXNz"){code=401;}
    else {
        if method=="GET"{if let Some(hook)=&m.on_get{hook(&path);}}
        if method=="PUT"&&m.race_put.as_ref().is_some_and(|(p,_)|p==&path){let (p,b)=m.race_put.take().unwrap();m.put(&p,b);}
        let tag=m.files.get(&path).map(|(_,v)|format!("\"v{v}\""));
        let precondition=!m.ignore_conditions&&(headers.get("if-match").is_some_and(|s|Some(s)!=tag.as_ref())||headers.get("if-none-match").is_some_and(|s|s=="*"&&tag.is_some()));
        if precondition{code=412;}
        else{match method.as_str(){
            "PROPFIND"=>{
                if !m.dirs.contains(&path){code=404;}
                else{code=207;
                    if let Some(xml)=&m.listing_override{body=xml.as_bytes().to_vec();}
                    else{let mut xml=format!("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">{}",xml_entry(&path,true,None));
                        if headers.get("depth").map(String::as_str)==Some("1"){
                            for dir in &m.dirs{if dir!=&path&&dir.starts_with(&path)&&!dir[path.len()..].trim_end_matches('/').contains('/'){xml.push_str(&xml_entry(dir,true,None));}}
                            for (name,(_,rev)) in &m.files{if name.starts_with(&path)&&!name[path.len()..].contains('/'){xml.push_str(&xml_entry(name,false,if m.weak{None}else{Some(*rev)}));}}
                        }xml.push_str("</d:multistatus>");body=xml.into_bytes();
                    }
                }
            },
            "MKCOL"=>{if m.dirs.contains(&path){code=405;}else if path.rsplit_once('/').is_some(){m.dirs.insert(path.clone());code=201;}else{code=409;}},
            "GET"=>{if let Some((data,rev))=m.files.get(&path){body=data.clone();if !m.weak{extra=format!("ETag: \"v{rev}\"\r\n");}}else{code=404;}},
            "PUT"=>{if m.fail_put.as_ref()==Some(&path){code=503;m.fail_put=None;}else{let exists=m.files.contains_key(&path);m.put(&path,bytes);if m.lost_put.as_ref()==Some(&path){m.lost_put=None;return Ok(());}code=if exists{204}else{201};}},
            "DELETE"=>{code=if m.files.remove(&path).is_some(){204}else{404};},_=>code=405
        }}
    }
    drop(m);write!(stream,"HTTP/1.1 {code} Test\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",body.len())?;stream.write_all(&body)?;stream.flush()
}
