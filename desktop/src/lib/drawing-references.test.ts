import {expect,it} from "vitest";
import {emptyDrawing,parseDrawing,serializeDrawing,defaultDrawingStyle as style} from "./drawing-document";
import {createDrawingElement} from "./drawing-geometry";
import {relocateNotes,rewriteDocumentLinks} from "./relocate-notes";
import {MemoryVault} from "../test/memory-vault";
import {createCanvasNode,parseCanvas,serializeCanvas} from "./canvas-document";
const drawing=()=>serializeDrawing({...emptyDrawing(),custom:1,elements:[{...createDrawingElement("text",{x:0,y:0},{x:0,y:0},style,"t"),text:"用户标签",link:{file:"资料/100% #.md",subpath:"#标题",custom:2}}]});
it("白板关联原始根路径不解码，另存不改变关联或未知字段",()=>{
 const source=drawing(),moved=rewriteDocumentLinks(source,"绘图/a.drawing","b.drawing",[{from:"资料",to:"项目"}],["资料/100% #.md"]);
 expect(parseDrawing(moved)).toMatchObject({custom:1,elements:[{id:"t",text:"用户标签",link:{file:"项目/100% #.md",subpath:"#标题",custom:2}}]});
 expect(rewriteDocumentLinks(source,"绘图/a.drawing","b.drawing",[],[])).toBe(source);
});
it("移动同时维护白板/草稿、Markdown入链与画布file，备份JSON不加Markdown注释",async()=>{
 const vault=new MemoryVault(),raw=drawing();vault.put("资料/100% #.md","原笔记");const original=vault.put("绘图/a.drawing",raw);
 vault.put("入口.md","[白板](绘图/a.drawing)");vault.put("图.canvas",serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:"绘图/a.drawing"})],edges:[]}));
 vault.stored.set(original.path,{path:original.path,content:raw,baseVersion:original.version});
 await relocateNotes([{from:"绘图/a.drawing",to:"归档/a.drawing"},{from:"资料/100% #.md",to:"资料/更名.md"}],vault);
 expect(parseDrawing(vault.notes.get("归档/a.drawing")!.content).elements[0].link!.file).toBe("资料/更名.md");
 expect(vault.notes.get("入口.md")!.content).toContain(encodeURIComponent("归档")+"/a.drawing");expect(parseCanvas(vault.notes.get("图.canvas")!.content).nodes[0].file).toBe("归档/a.drawing");
 expect(vault.stored.has(original.path)).toBe(false);expect(parseDrawing(vault.stored.get("归档/a.drawing")!.content).elements[0].link!.file).toBe("资料/更名.md");
 const backup=[...vault.notes.keys()].find(p=>p.includes("恢复草稿/绘图/a.drawing")&&!p.endsWith(".md"))!;
 expect(vault.notes.get(backup)!.content).toBe(raw);expect(vault.notes.has(backup+".meta.md")).toBe(true);
});
it("坏白板及坏恢复草稿在任何移动之前拒绝，版本和原文不变",async()=>{
 const vault=new MemoryVault();vault.put("a.md","原文");vault.put("a.drawing","{bad");
 await expect(relocateNotes([{from:"a.md",to:"b.md"}],vault)).rejects.toThrow(/JSON/);expect(vault.notes.has("b.md")).toBe(false);
 const original=vault.put("a.drawing",drawing());vault.stored.set(original.path,{path:original.path,content:"{}",baseVersion:original.version});
 await expect(relocateNotes([{from:"a.drawing",to:"b.drawing"}],vault)).rejects.toThrow(/格式/);
 expect(vault.notes.get(original.path)).toEqual(original);expect(vault.stored.get(original.path)?.content).toBe("{}");
});
