use atomicwrites::{AllowOverwrite,AtomicFile};
use quick_xml::{Reader,events::Event};
use std::{fs,io::Write,path::Path};
pub const MAX_SVG_BYTES:usize=16*1024*1024;
fn legal_char(c:char)->bool{c=='\t'||c=='\n'||c=='\r'||c>='\u{20}'&&c!='\u{fffe}'&&c!='\u{ffff}'}
pub fn validate_svg(svg:&str)->Result<(),String>{
    let invalid=||"SVG 包含不支持的格式、属性或外部/交互内容".to_owned();
    if svg.len()>MAX_SVG_BYTES{return Err("SVG 超过 16 MiB".into());}
    if !svg.chars().all(legal_char){return Err(invalid());}
    let mut reader=Reader::from_str(svg);let mut stack:Vec<String>=Vec::new();let mut root=false;
    loop{
        let event=reader.read_event().map_err(|_|invalid())?;
        let empty=matches!(&event,Event::Empty(_));
        match event{
            Event::Start(e)|Event::Empty(e)=>{
                let name=e.name().0;
                if !["svg","rect","ellipse","circle","line","polyline","polygon","text","tspan"].contains(&name){return Err(invalid());}
                if stack.is_empty(){if root||name!="svg" {return Err(invalid());}root=true;}
                else if name=="svg"{return Err(invalid());}
                if stack.len()>16{return Err(invalid());}
                let mut namespace=false;
                for attr in e.attributes(){
                    let attr=attr.map_err(|_|invalid())?;let key=attr.key.0;
                    let v=attr.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|_|invalid())?;
                    match key{
                        "xmlns" if name=="svg"&&v=="http://www.w3.org/2000/svg"=>namespace=true,
                        "fill"|"stroke" if v=="none"||v.len()==7&&v.starts_with('#')&&v[1..].bytes().all(|b|b.is_ascii_hexdigit())=>(),
                        "stroke-linecap"|"stroke-linejoin" if v=="round"=>(),
                        "font-family" if v=="sans-serif"=>(),
                        "xml:space" if v=="preserve"=>(),
                        "x"|"y"|"width"|"height"|"viewBox"|"cx"|"cy"|"rx"|"ry"|"r"|"x1"|"y1"|"x2"|"y2"|"stroke-width"|"font-size"|"points"=>{
                            let mut values=0;
                            for n in v.split(|c:char|c.is_ascii_whitespace()||c==',').filter(|x|!x.is_empty()){
                                let n=n.parse::<f64>().map_err(|_|invalid())?;
                                if !n.is_finite()||n.abs()>1e8||name=="svg"&&(["width","height"].contains(&key)||key=="viewBox"&&values>=2)&&(n<=0.0||n>100000.0){return Err(invalid());}values+=1;
                            }
                            if values==0{return Err(invalid());}
                            if key=="viewBox"&&values!=4{return Err(invalid());}
                        },
                        _=>return Err(invalid())
                    }
                }
                if name=="svg"&&!namespace{return Err(invalid());}
                if !empty{stack.push(name.to_owned());}
            },
            Event::End(e)=>{if stack.pop().as_deref()!=Some(e.name().0){return Err(invalid());}},
            Event::Text(e)=>{if !e.trim().is_empty()&&!stack.last().is_some_and(|n|n=="text"||n=="tspan"){return Err(invalid());}},
            Event::GeneralRef(e)=>{
                if !stack.last().is_some_and(|n|n=="text"||n=="tspan"){return Err(invalid());}
                match e.resolve_char_ref().map_err(|_|invalid())?{
                    Some(c) if legal_char(c)=>(),
                    None if ["amp","lt","gt","quot","apos"].contains(&&*e)=>(),
                    _=>return Err(invalid())
                }
            },
            Event::Eof=>break,
            _=>return Err(invalid())
        }
    }
    if !root||!stack.is_empty(){return Err(invalid());}Ok(())
}
pub fn write_svg(path:&Path,svg:&str)->Result<(),String>{
    validate_svg(svg)?;
    if !path.extension().is_some_and(|e|e.eq_ignore_ascii_case("svg")){return Err("请选择 .svg，不能覆盖笔记、画布或白板源文件".into());}
    if let Ok(m)=fs::symlink_metadata(path){if m.file_type().is_symlink()||!m.is_file(){return Err("SVG 目标必须是普通文件".into());}}
    AtomicFile::new(path,AllowOverwrite).write(|file|{file.write_all(svg.as_bytes())?;file.sync_all()}).map_err(|e|format!("SVG 保存失败：{e}"))
}
#[cfg(test)]
mod tests{
    use super::*;
    const SVG:&str="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"100\" viewBox=\"-10 -10 200 100\"><text fill=\"#123456\"><tspan x=\"0\" y=\"20\">中文 &amp; &lt;文字&gt;</tspan></text><polyline points=\"0,0 20,30\" fill=\"none\" stroke=\"#123456\" stroke-width=\"2\"/></svg>";
    #[test]fn svg_whitelist_rejects_executable_or_external_content(){
        validate_svg(SVG).unwrap();
        for svg in ["<svg/>","<!DOCTYPE svg><svg/>","<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>","<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://example.org\"/></svg>","<svg xmlns=\"http://www.w3.org/2000/svg\" style=\"fill:url(x)\"/>","<svg xmlns=\"http://www.w3.org/2000/svg\"></svg><svg/>","<svg xmlns=\"http://www.w3.org/2000/svg\"><text>&external;</text></svg>"]{assert!(validate_svg(svg).is_err(),"{svg}");}
        assert!(validate_svg(&"x".repeat(MAX_SVG_BYTES+1)).is_err());
        assert!(validate_svg("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\" viewBox=\"0 0 100001 10\"/>").is_err());
        assert!(validate_svg("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\" viewBox=\"0 0 10\"/>").is_err());
    }
    #[test]fn svg_target_is_separate_from_html_and_source(){
        let root=tempfile::tempdir().unwrap();let output=root.path().join("中文.svg");
        fs::write(&output,"previous").unwrap();assert!(write_svg(&output,"broken").is_err());assert_eq!(fs::read_to_string(&output).unwrap(),"previous");
        write_svg(&output,SVG).unwrap();assert_eq!(fs::read_to_string(&output).unwrap(),SVG);
        for name in ["note.md","board.canvas","board.drawing","export.html"]{let p=root.path().join(name);fs::write(&p,"source").unwrap();assert!(write_svg(&p,SVG).is_err());assert_eq!(fs::read_to_string(p).unwrap(),"source");}
        assert!(write_svg(&root.path().join("missing/file.svg"),SVG).is_err());
        assert!(write_svg(root.path(),SVG).is_err());
    }
}
