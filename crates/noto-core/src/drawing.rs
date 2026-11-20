use crate::VaultError;
use serde_json::Value;
use std::collections::HashSet;
pub const MAX_DRAWING_BYTES:usize=8*1024*1024;
const INVALID:VaultError=VaultError::InvalidDrawing;
fn number(value:&Value)->bool {value.as_f64().is_some_and(|n|n.is_finite()&&n.abs()<=1e7)}
fn color(value:&Value)->bool {value.as_str().is_some_and(|v|v.len()==7&&v.starts_with('#')&&v[1..].bytes().all(|b|b.is_ascii_hexdigit()))}
pub fn check(content:&str)->Result<(),VaultError>{
    if content.len()>MAX_DRAWING_BYTES{return Err(VaultError::DrawingTooLarge);}
    let data:Value=serde_json::from_str(content).map_err(|_|INVALID)?;
    if data["type"]!="noto-drawing"||data["version"]!=1||!color(&data["background"]){return Err(INVALID);}
    let elements=data["elements"].as_array().ok_or(INVALID)?;
    if elements.len()>2000{return Err(VaultError::DrawingTooLarge);}
    let mut ids=HashSet::new();let mut total=0usize;
    for e in elements{
        let id=e["id"].as_str().ok_or(INVALID)?;
        if id.is_empty()||id.chars().count()>256||id.chars().any(char::is_control)||!ids.insert(id){return Err(INVALID);}
        let kind=e["type"].as_str().ok_or(INVALID)?;
        if !["pencil","rectangle","ellipse","line","arrow","text"].contains(&kind)||!["x","y","width","height"].iter().all(|k|number(&e[k]))||!color(&e["strokeColor"]){return Err(INVALID);}
        let x=e["x"].as_f64().ok_or(INVALID)?;let y=e["y"].as_f64().ok_or(INVALID)?;
        let width=e["width"].as_f64().ok_or(INVALID)?;let height=e["height"].as_f64().ok_or(INVALID)?;
        if ["line","arrow"].contains(&kind){
            if width==0.0&&height==0.0||(x+width).abs()>1e7||(y+height).abs()>1e7{return Err(INVALID);}
        }else if width<=0.0||height<=0.0{return Err(INVALID);}
        if let Some(v)=e.get("fillColor"){if v!="transparent"&&!color(v){return Err(INVALID);}}
        for (key,min,max) in [("strokeWidth",1.0,16.0),("fontSize",12.0,96.0)]{
            if let Some(v)=e.get(key){if !v.as_f64().is_some_and(|n|n.is_finite()&&n>=min&&n<=max){return Err(INVALID);}}
        }
        if kind=="text"&&(!e["text"].is_string()||!e["fontSize"].is_number()){return Err(INVALID);}
        if kind=="pencil"{
            let points=e["points"].as_array().ok_or(INVALID)?;
            if points.is_empty(){return Err(INVALID);}
            if points.len()>10000{return Err(VaultError::DrawingTooLarge);}
            total+=points.len();if total>200000{return Err(VaultError::DrawingTooLarge);}
            for p in points{
                let p=p.as_array().ok_or(INVALID)?;
                if p.len()!=2||!p.iter().all(number)||p[0].as_f64().ok_or(INVALID)?<0.0||p[1].as_f64().ok_or(INVALID)?<0.0||p[0].as_f64().ok_or(INVALID)?>width||p[1].as_f64().ok_or(INVALID)?>height{return Err(INVALID);}
            }
        }else if e.get("points").is_some(){return Err(INVALID);}
        if let Some(link)=e.get("link"){
            let file=link["file"].as_str().ok_or(INVALID)?;
            if !link.is_object()||file.is_empty()||file.len()>=4096||file.chars().any(|c|c.is_control()||c=='\\'||c==':')||file.split('/').any(|p|p.is_empty()||p.starts_with('.'))||!std::path::Path::new(file).extension().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("md")||x.eq_ignore_ascii_case("markdown")){return Err(INVALID);}
            if let Some(subpath)=link.get("subpath"){if !subpath.as_str().is_some_and(|s|s.starts_with('#')){return Err(INVALID);}}
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests{
    use super::*;
    use crate::Vault;
    use serde_json::json;
    use std::fs;
    fn empty()->String{json!({"type":"noto-drawing","version":1,"background":"#ffffff","elements":[]}).to_string()}
    #[test]fn drawing_versions_raw_backups_and_read_limits(){
        let root=tempfile::tempdir().unwrap();let vault=Vault::open(root.path()).unwrap();let source=empty();
        let created=vault.create_note("中文 % #.drawing",&source).unwrap();assert!(vault.create_note("中文 % #.drawing",&source).is_err());
        let next=source.replace("#ffffff","#123456");let saved=vault.save_note(&created.path,&next,&created.version).unwrap();
        assert!(matches!(vault.save_note(&created.path,&source,&created.version),Err(VaultError::Conflict)));
        assert!(matches!(vault.save_note(&created.path,"{bad",&saved.version),Err(VaultError::InvalidDrawing)));assert_eq!(vault.read_note(&created.path).unwrap().content,next);
        let raw=format!("\u{feff}{}\r\n",source);fs::write(root.path().join("raw.DRAWING"),raw.as_bytes()).unwrap();let note=vault.read_note("raw.DRAWING").unwrap();
        vault.backup_document("raw.DRAWING",".noto-structure-backup-drawing",&note.version).unwrap();
        assert_eq!(fs::read(root.path().join(".noto-structure-backup-drawing/原文/raw.DRAWING")).unwrap(),raw.as_bytes());
        assert!(vault.backup_document("raw.DRAWING",".noto-structure-backup-drawing",&note.version).is_err());
        vault.save_note("raw.DRAWING",&next,&note.version).unwrap();assert!(fs::read(root.path().join("raw.DRAWING")).unwrap().starts_with(&[0xef,0xbb,0xbf]));
        fs::write(root.path().join("broken.drawing"),"{bad").unwrap();assert_eq!(vault.read_note("broken.drawing").unwrap().content,"{bad");
        fs::File::create(root.path().join("big.drawing")).unwrap().set_len(MAX_DRAWING_BYTES as u64+1).unwrap();assert!(matches!(vault.read_note("big.drawing"),Err(VaultError::DrawingTooLarge)));
        assert!(!root.path().join("oversize.drawing").exists());assert!(matches!(vault.create_note("oversize.drawing",&"x".repeat(MAX_DRAWING_BYTES+1)),Err(VaultError::DrawingTooLarge)));assert!(!root.path().join("oversize.drawing").exists());
    }
    #[test]fn drawing_schema_and_element_point_limits_are_checked_before_creation(){
        for value in [json!({}),json!({"type":"drawing","version":2,"elements":[]}),json!({"type":"noto-drawing","version":2,"background":"#ffffff","elements":[]})]{assert!(check(&value.to_string()).is_err());}
        let root=tempfile::tempdir().unwrap();let vault=Vault::open(root.path()).unwrap();
        let mut value:Value=serde_json::from_str(&empty()).unwrap();
        let pen=json!({"id":"p","type":"pencil","x":-10,"y":-20,"width":100,"height":100,"strokeColor":"#123456","strokeWidth":4,"points":[[0,0],[100,100]]});
        value["elements"]=json!([pen]);check(&value.to_string()).unwrap();
        value["elements"][0]["link"]=json!({"file":"../outside.md"});assert!(matches!(check(&value.to_string()),Err(VaultError::InvalidDrawing)));
        value["elements"][0].as_object_mut().unwrap().remove("link");value["elements"][0]["points"]=json!(vec![[0,0];10001]);
        assert!(matches!(check(&value.to_string()),Err(VaultError::DrawingTooLarge)));
        value["elements"]=json!(vec![Value::Null;2001]);assert!(matches!(vault.create_note("count.drawing",&value.to_string()),Err(VaultError::DrawingTooLarge)));assert!(!root.path().join("count.drawing").exists());
        value["elements"]=json!([{"id":"a","type":"arrow","x":100,"y":100,"width":-100,"height":0,"strokeColor":"#123456"}]);check(&value.to_string()).unwrap();
        value["elements"][0]["width"]=json!(0);assert!(check(&value.to_string()).is_err());
    }
    #[cfg(unix)]
    #[test]fn file_symlinks_cannot_bypass_the_drawing_type_and_capacity(){
        let root=tempfile::tempdir().unwrap();let vault=Vault::open(root.path()).unwrap();
        fs::write(root.path().join("source.txt"),"original").unwrap();
        std::os::unix::fs::symlink(root.path().join("source.txt"),root.path().join("alias.drawing")).unwrap();
        assert!(matches!(vault.read_note("alias.drawing"),Err(VaultError::InvalidPath)));
        assert!(matches!(vault.save_note("alias.drawing",&empty(),"any"),Err(VaultError::InvalidPath)));
        assert_eq!(fs::read_to_string(root.path().join("source.txt")).unwrap(),"original");
        assert!(vault.backup_document("alias.drawing",".noto-structure-backup-link","any").is_err());
    }
}
