import {expect,it,vi} from "vitest";
import {emptyDrawing,serializeDrawing,defaultDrawingStyle} from "./drawing-document";
import {createDrawingElement} from "./drawing-geometry";
import {drawingPreview} from "./drawing-preview";
import {formatDrawingEmbed,loadNoteEmbeds,resolveEmbed} from "./note-embed";
import {rewriteDocumentLinks,relocateNotes} from "./relocate-notes";
import {createCanvasNode,parseCanvas,serializeCanvas} from "./canvas-document";
import {MemoryVault} from "../test/memory-vault";

const drawing=(text:string)=>serializeDrawing({...emptyDrawing(),elements:[{...createDrawingElement("text",{x:0,y:0},{x:0,y:0},defaultDrawingStyle,"text"),text,link:{file:"私密.md"}}]});
const svg=(uri:string)=>new TextDecoder().decode(Uint8Array.from(atob(uri.split(",")[1]),c=>c.charCodeAt(0)));

it("白板 SVG 快照仅渲染已验证元素，转义文字并排除关联元数据",()=>{
 const value=svg(drawingPreview(drawing('<script> & "内容"')));
 expect(value).toContain("&lt;script&gt;");expect(value).not.toContain("<script>");expect(value).not.toContain("私密.md");
 expect(()=>drawingPreview('{"type":"drawing","version":2}')).toThrow();
});
it("白板快照超过预览容量时明确拒绝，不改动原文",()=>{
 const element=createDrawingElement("text",{x:0,y:0},{x:0,y:0},defaultDrawingStyle,"text"),text="X".repeat(1100);
 const source=serializeDrawing({...emptyDrawing(),elements:Array.from({length:2000},(_,i)=>({...element,id:String(i),text}))}),before=source;
 expect(()=>drawingPreview(source)).toThrow("预览超过 2 MiB");expect(source).toBe(before);
});
it("白板嵌入按完整文件优先解析，同名不猜测，特殊路径复制可回读",()=>{
 const paths=["画板/100%20 #.drawing","甲/同名.drawing","乙/同名.drawing","根.drawing","目录/根.drawing","画板/[a]&文.drawing"];
 expect(resolveEmbed("画板/100%20 #.drawing","笔记.md",[],paths)).toMatchObject({path:paths[0],fragment:null});
 expect(resolveEmbed("画板/100%20 #.drawing#标题","笔记.md",[],paths).error).toContain("不支持标题");
 expect(resolveEmbed("同名.drawing","笔记.md",[],paths).error).toBe("存在同名白板");
 expect(resolveEmbed("../根.drawing","笔记.md",[],paths).error).toBe("无效嵌入目标");
 expect(formatDrawingEmbed(paths[0],paths)).toBe("![[画板/100%20 #.drawing]]");
 expect(formatDrawingEmbed("根.drawing",paths)).toBe("![[./根.drawing]]");
 expect(formatDrawingEmbed("画板/[a]&文.drawing",paths)).toBe("![[画板/&#91;a&#93;&#38;文.drawing]]");
 expect(()=>formatDrawingEmbed("含|竖线.drawing",["含|竖线.drawing"])).toThrow();
});
it("只读取保存态，重复引用共享读取，错误与取消不改文件",async()=>{
 const read=vi.fn(async(path:string)=>({path,content:drawing("磁盘内容"),version:"1"}));
 const result=await loadNoteEmbeds("![[白板.drawing]]\n\n![[白板.drawing|另一个]]\n\n![[丢失.drawing]]","笔记.md",[],read,()=>false,["白板.drawing"]);
 expect(read).toHaveBeenCalledTimes(1);expect(result?.[0].image).toBe(result?.[1].image);expect(svg(result![0].image!)).toContain("磁盘内容");expect(result?.[2].error).toBe("白板不存在");
 let finish!:(value:{path:string;content:string;version:string})=>void,stale=false;
 const pending=loadNoteEmbeds("![[白板.drawing]]","笔记.md",[],()=>new Promise(resolve=>{finish=resolve;}),()=>stale,["白板.drawing"]);
 stale=true;finish({path:"白板.drawing",content:drawing("旧库"),version:"1"});expect(await pending).toBeNull();
 const bad=await loadNoteEmbeds("![[白板.drawing]]","笔记.md",[],async path=>({path,content:"{坏文件",version:"1"}),()=>false,["白板.drawing"]);
 expect(bad?.[0].error).toContain("读取失败");
});
it("白板移动维护笔记、画布文本和恢复草稿中的嵌入，同时保留代码示例",async()=>{
 const vault=new MemoryVault();vault.put("图/100% #.drawing",drawing("保存"));
 const source="![[图/100% #.drawing|图例]]\n\n`![[图/100% #.drawing]]`";
 const note=vault.put("笔记.md",source),canvasPath="画布.canvas";
 vault.put(canvasPath,serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{text:source}),createCanvasNode("file",{x:300,y:0},{file:"图/100% #.drawing"})],edges:[]}));
 vault.stored.set(note.path,{path:note.path,content:source+"\n\n草稿",baseVersion:note.version});
 await relocateNotes([{from:"图/100% #.drawing",to:"新图/移动 #.drawing"}],vault);
 const rewritten="![[新图/移动 #.drawing|图例]]\n\n`![[图/100% #.drawing]]`";
 expect(vault.notes.get(note.path)?.content).toBe(rewritten);expect(vault.stored.get(note.path)?.content).toBe(rewritten+"\n\n草稿");
 const canvas=parseCanvas(vault.notes.get(canvasPath)!.content);expect(canvas.nodes[0].text).toBe(rewritten);expect(canvas.nodes[1].file).toBe("新图/移动 #.drawing");
 expect(()=>rewriteDocumentLinks("![[a.drawing]]","笔记.md","笔记.md",[{from:"a.drawing",to:"a|b.drawing"}],["笔记.md","a.drawing"])).toThrow("无法安全改写");
});
