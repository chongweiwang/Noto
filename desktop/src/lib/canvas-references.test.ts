import {expect,it} from "vitest";
import {rewriteDocumentLinks,relocateNotes} from "./relocate-notes";
import {MemoryVault} from "../test/memory-vault";
import {canvasFreehand,createCanvasFreehand,createCanvasNode,serializeCanvas,parseCanvas} from "./canvas-document";
const canvas=()=>serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:"笔记/100%20 #.md",custom:1}),createCanvasNode("file",{x:300,y:0},{file:"画布/attachments/a.png"}),createCanvasNode("text",{x:0,y:300},{text:"[正文](../笔记/100%2520%20%23.md) ![图](attachments/a.png)"})],edges:[],custom:{keep:true}});
it("移动目标更新根路径，移画布只重算卡片 Markdown 相对链接，百分号不重复解码",()=>{
 const original=canvas(),moves=[{from:"笔记",to:"资料"},{from:"画布/attachments/a.png",to:"资源/a.png"}];
 const changed=rewriteDocumentLinks(original,"画布/主题.canvas","整理/主题.canvas",moves,["笔记/100%20 #.md"]);
 const data=parseCanvas(changed);expect(data.nodes[0]).toMatchObject({file:"资料/100%20 #.md",custom:1});
 expect(data.nodes[1].file).toBe("资源/a.png");
 expect(data.nodes[2].text).toContain("../%E8%B5%84%E6%96%99/100%2520%20%23.md");
 expect(data.nodes[2].text).toContain("../%E8%B5%84%E6%BA%90/a.png");
 expect(data.custom).toEqual({keep:true});
 expect(rewriteDocumentLinks(original,"画布/主题.canvas","画布/主题.canvas",[],[])).toBe(original);
});
it("受控整理同时维护画布、Markdown 入链与恢复草稿",async()=>{
 const vault=new MemoryVault();vault.folders.add("画布");vault.folders.add("笔记");
 vault.put("笔记/a.md","正文");const c=vault.put("画布/a.canvas",serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:"笔记/a.md"})],edges:[]}));
 vault.put("入口.md","[画布](画布/a.canvas)");vault.stored.set(c.path,{path:c.path,content:c.content,baseVersion:c.version});
 await relocateNotes([{from:"画布/a.canvas",to:"新画布.canvas"},{from:"笔记/a.md",to:"笔记/b.md"}],vault);
 expect(vault.notes.get("入口.md")?.content).toContain(encodeURIComponent("新画布")+".canvas");
 expect(parseCanvas(vault.notes.get("新画布.canvas")!.content).nodes[0].file).toBe("笔记/b.md");
 expect(vault.stored.has("画布/a.canvas")).toBe(false);expect(parseCanvas(vault.stored.get("新画布.canvas")!.content).nodes[0].file).toBe("笔记/b.md");
});
it("路径迁移改写文本引用时保留画布笔迹与样式",()=>{
 const stroke=createCanvasFreehand([{x:0,y:0},{x:100,y:50}],"#123456",4);
 const input=serializeCanvas({nodes:[stroke,createCanvasNode("file",{x:300,y:0},{file:"笔记/a.md"})],edges:[]});
 const output=rewriteDocumentLinks(input,"主题.canvas","主题.canvas",[{from:"笔记/a.md",to:"笔记/b.md"}],["笔记/a.md"]);
 const result=parseCanvas(output);expect(result.nodes[1].file).toBe("笔记/b.md");expect(canvasFreehand(result.nodes[0])).toEqual(canvasFreehand(stroke));
});
it("损坏画布或坏草稿在任何移动之前拒绝，原始字节和路径保留",async()=>{
 const vault=new MemoryVault();vault.put("a.md","正文");const canvas=vault.put("a.canvas","{bad");
 await expect(relocateNotes([{from:"a.md",to:"b.md"}],vault)).rejects.toThrow("JSON");
 expect(vault.notes.get("a.canvas")?.content).toBe("{bad");expect(vault.notes.has("b.md")).toBe(false);
 vault.put("a.canvas",'{"nodes":[],"edges":[]}');vault.stored.set("a.canvas",{path:"a.canvas",content:"坏草稿",baseVersion:canvas.version});
 await expect(relocateNotes([{from:"a.canvas",to:"b.canvas"}],vault)).rejects.toThrow("JSON");
 expect(vault.notes.has("b.canvas")).toBe(false);expect(vault.stored.get("a.canvas")?.content).toBe("坏草稿");
});
