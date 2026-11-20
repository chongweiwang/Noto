// @vitest-environment jsdom
import {expect,it,vi} from "vitest";
import {prepareNoteExport,type ExportSnapshot} from "./note-export";
import {emptyDrawing,serializeDrawing,defaultDrawingStyle} from "./drawing-document";
import {createDrawingElement} from "./drawing-geometry";

vi.mock("./mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
const path="图/100% #.drawing";
const drawing=(text:string)=>serializeDrawing({...emptyDrawing(),elements:[{...createDrawingElement("text",{x:0,y:0},{x:0,y:0},defaultDrawingStyle,"text"),text,link:{file:"私密.md"},privateField:"不应导出"}]});
const snapshot=(content:string,drawingPaths=[path]):ExportSnapshot=>({path:"目录/笔记.md",content,unsaved:true,conflict:false,paths:["目录/笔记.md","目标.md"],drawingPaths,capturedAt:1});
const parse=(html:string)=>new DOMParser().parseFromString(html,"text/html");
const svg=(uri:string)=>new TextDecoder().decode(Uint8Array.from(atob(uri.split(",")[1]),c=>c.charCodeAt(0)));

it("静态 HTML 自包含已保存白板，重复引用共读共解码，并安全保留别名",async()=>{
 let saved=drawing('磁盘文字 <script> & "中文"');
 const read=vi.fn(async(file:string)=>({path:file,content:saved,version:"v1"})),image=vi.fn(),decodeImage=vi.fn(async()=>{});
 const input=snapshot("![[图/100% #.drawing|原图]]\n\n![[图/100% #.drawing|第二处]]"),result=await prepareNoteExport(input,{read,image},{decodeImage});
 const doc=parse(result.html),figures=[...doc.querySelectorAll("figure.export-drawing-embed")];
 expect(figures).toHaveLength(2);expect(figures[0].querySelector("figcaption")?.textContent).toBe("白板：原图（已保存内容）");
 const pictures=figures.map(figure=>figure.querySelector("img")!);expect(pictures[0].getAttribute("alt")).toBe("原图");
 expect(pictures[0].src).toMatch(/^data:image\/svg\+xml;base64,/);expect(pictures[1].src).toBe(pictures[0].src);
 const savedSvg=svg(pictures[0].src);expect(savedSvg).toContain("磁盘文字");expect(savedSvg).toContain("&lt;script&gt;");expect(savedSvg).not.toContain("<script>");expect(savedSvg).not.toContain("私密.md");expect(savedSvg).not.toContain("不应导出");
 expect(read).toHaveBeenCalledTimes(1);expect(image).not.toHaveBeenCalled();expect(decodeImage).toHaveBeenCalledTimes(1);expect(result.warnings).toEqual([]);
 expect(result.html).toContain("img-src data:");expect(result.html).not.toContain("<script");expect(result.html).toContain("max-height:220mm");
 saved=drawing("后来保存");const next=await prepareNoteExport(input,{read,image},{decodeImage});
 expect(svg(parse(next.html).querySelector("figure img")!.getAttribute("src")!)).toContain("后来保存");expect(svg(pictures[0].src)).toContain("磁盘文字");
});

it("缺失、歧义、损坏和行内白板明确警告，保留原始引用",async()=>{
 const source="![[同名.drawing]]\n\n![[丢失.drawing]]\n\n![[坏.drawing]]\n\n行内 ![[坏.drawing]]";
 const read=vi.fn(async(file:string)=>({path:file,version:"1",content:"{损坏"}));
 const result=await prepareNoteExport(snapshot(source,["甲/同名.drawing","乙/同名.drawing","坏.drawing"]),{read,image:vi.fn()},{decodeImage:async()=>{}}),doc=parse(result.html);
 expect(result.warnings.map(w=>[w.line,w.message])).toEqual([[1,"存在同名白板"],[3,"白板不存在"],[5,expect.stringContaining("白板 JSON 无法解析")],[7,"行内嵌入未展开"]]);
 expect(doc.body.textContent).toContain("![[同名.drawing]]");expect(doc.body.textContent).toContain("![[坏.drawing]]");expect(doc.querySelector("figure.export-drawing-embed")).toBeNull();expect(read).toHaveBeenCalledTimes(1);
});

it("白板解码失败生成带行号的警告和占位说明，原文 data 图片仍被拒绝",async()=>{
 const source="标题\n\n![[图/100% #.drawing]]\n\n![伪造](data:image/svg+xml;base64,PHN2Zy8+)",read=vi.fn(async(file:string)=>({path:file,version:"1",content:drawing("磁盘")}));
 const result=await prepareNoteExport(snapshot(source),{read,image:vi.fn()},{decodeImage:async()=>{throw new Error("解码失败");}}),doc=parse(result.html);
 expect(result.warnings).toEqual(expect.arrayContaining([{line:3,message:"白板预览无法解码："+path},{line:5,message:"图片未包含或无法读取：伪造"}]));
 expect(doc.body.textContent).toContain("白板预览无法导出："+path);expect(doc.querySelectorAll("img")).toHaveLength(0);
});

it("白板内容计入整个导出的大小上限，超限不返回部分成品",async()=>{
 const image=vi.fn(),read=vi.fn(async(file:string)=>({path:file,version:"1",content:drawing("内容".repeat(1000))})),decodeImage=async()=>{};
 const baseline=await prepareNoteExport(snapshot(""),{read,image},{decodeImage});
 await expect(prepareNoteExport(snapshot("![[图/100% #.drawing]]"),{read,image},{decodeImage,maxBytes:baseline.bytes+300})).rejects.toThrow("导出内容超过大小上限");
});

it("取消白板读取和解码立即中止导出，迟到结果不会成为成品",async()=>{
 const first=new AbortController();let deliver!:(value:{path:string;version:string;content:string})=>void;
 const read=vi.fn(()=>new Promise<{path:string;version:string;content:string}>(resolve=>{deliver=resolve;}));
 const pending=prepareNoteExport(snapshot("![[图/100% #.drawing]]"),{read,image:vi.fn()},{decodeImage:async()=>{},signal:first.signal});
 await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());first.abort();await expect(pending).rejects.toMatchObject({name:"AbortError"});deliver({path,version:"1",content:drawing("迟到")});
 const second=new AbortController();let decoded!:()=>void;const decodeImage=vi.fn(()=>new Promise<void>(resolve=>{decoded=resolve;}));
 const waiting=prepareNoteExport(snapshot("![[图/100% #.drawing]]"),{read:async file=>({path:file,version:"1",content:drawing("保存")}),image:vi.fn()},{decodeImage,signal:second.signal});
 await vi.waitFor(()=>expect(decodeImage).toHaveBeenCalledOnce());second.abort();await expect(waiting).rejects.toMatchObject({name:"AbortError"});decoded();
});
