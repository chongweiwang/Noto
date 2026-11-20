// @vitest-environment jsdom
import { expect,it,vi } from "vitest";
import { prepareNoteExport,exportFileName,type ExportSnapshot } from "./note-export";
import { safeExportImage,base64Text,bounded } from "./export-resources";
vi.mock("./mermaid",()=>({renderMermaid:async()=>'<svg xmlns="http://www.w3.org/2000/svg"><text>图</text></svg>'}));
const png="data:image/png;base64,aGVsbG8=";
const snapshot=(content:string):ExportSnapshot=>({path:"笔记/中文.md",content,unsaved:true,conflict:false,paths:["笔记/中文.md","其他.md"],drawingPaths:[],capturedAt:1});
const parsed=(html:string)=>new DOMParser().parseFromString(html,"text/html");
const decodeImage=vi.fn(async()=>{});
it("导出冻结的单层标题嵌入，目标图片按目标路径读取且锚点不冲突",async()=>{
 const input=snapshot("# 章节\n\n![[其他.md#章节|摘录]]"),image=vi.fn(async()=>png);
 const read=vi.fn(async(path:string)=>({path,version:"v1",content:"# 章节\n\n- [ ] 待办\n\n![图](图.png)\n\n$x^2$\n\n~~~mermaid\nflowchart LR\nA-->B\n~~~\n\n脚注[^a]\n\n[^a]: 说明\n\n![[深层]]\n\n# 结束\n不应包含"}));
 const result=await prepareNoteExport(input,{image,read},{decodeImage});
 const doc=parsed(result.html),section=doc.querySelector(".export-note-embed")!;
 expect(section.textContent).toContain("待办");expect(section.textContent).not.toContain("不应包含");
 expect(section.querySelector("input")?.disabled).toBe(true);expect(image).toHaveBeenCalledWith("其他.md","图.png");
 expect(section.querySelector(".katex")).toBeTruthy();expect(section.querySelector("figure img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
 expect(result.warnings.map(item=>item.message)).toContain("嵌套嵌入未展开");
 const ids=[...doc.querySelectorAll("[id]")].map(node=>node.id);expect(new Set(ids).size).toBe(ids.length);
 expect(doc.getElementById("章节")).toBeTruthy();expect(section.querySelector("h1")?.id).not.toBe("章节");
});
it("嵌入目标不可读时保留说明，不能伪装成完整导出",async()=>{
 const read=vi.fn(async()=>{throw new Error("磁盘失败");});
 const result=await prepareNoteExport(snapshot("![[其他]]"),{image:vi.fn(),read},{decodeImage});
 expect(parsed(result.html).body.textContent).toContain("读取失败");
 expect(result.warnings.some(item=>item.message.includes("读取失败"))).toBe(true);
});
it("HTML 保留旧标记原文，旧链接显示提示且不读取嵌入目标",async()=>{
 const input=snapshot("宿主正文 ^ref\n\n[[#^ref|旧链接]]\n\n![[其他#^other]]");
 const read=vi.fn(async(path:string)=>({path,version:"v1",content:"目标段落 ^other"})),image=vi.fn(async()=>png);
 const result=await prepareNoteExport(input,{image,read},{decodeImage}),doc=parsed(result.html);
 expect(doc.body.textContent).toContain("宿主正文 ^ref");
 expect(doc.querySelector(".export-target")?.textContent).toContain("旧链接（不支持的 Wiki 链接片段");
 expect(doc.querySelector(".export-note-embed")).toBeNull();
 expect(read).not.toHaveBeenCalled();
});
it("导出真实语法树：GFM、公式、脚注及同名标题的稳定锚点，样式字体自包含",async()=>{
 const source="# 中文\n\n## 重复\n\n## 重复\n\n另一个\n===\n\n- [x] 已完成\n  - 子列表\n\n| 项目 | 值 |\n| --- | ---: |\n| 中文 | 1 |\n\n行内 $x^2$。\n\n$$\n\\frac{1}{2}\n$$\n\n~~~rust\nlet value = 1;\n~~~\n\n脚注[^a]\n\n[^a]: 说明\n\n[重复](#重复-1)";
 const result=await prepareNoteExport(snapshot(source),{image:vi.fn()},{decodeImage});
 const doc=parsed(result.html);
 expect(result.warnings).toEqual([]);
 expect(doc.querySelectorAll("table")).toHaveLength(1);
 expect(doc.querySelector("input")?.checked).toBe(true);
 expect(doc.querySelector("input")?.disabled).toBe(true);
 expect(doc.querySelectorAll(".katex")).toHaveLength(2);
 expect(doc.getElementById("重复-1")).not.toBeNull();
 expect(doc.getElementById("footnote-label")).not.toBeNull();
 for(const link of doc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) expect(doc.getElementById(decodeURIComponent(link.getAttribute("href")!.slice(1)))).not.toBeNull();
 expect(result.html).toContain("data:font/woff2;base64,");
 expect(result.html).not.toMatch(/url\(fonts\/|\/_next\/|<script|data-heading-from|onclick=/i);
 expect(doc.querySelector("title")?.textContent).toBe("中文");
});
it("图片去重、Mermaid 预渲染，无远程读取；缺图和内部链接保留明确警告",async()=>{
 const image=vi.fn(async()=>png);
 const source="![一](attachments/a.png)\n\n![二](attachments/a.png)\n\n![远程](https://remote.test/x.png)\n\n[[其他|别名]]\n\n[附件](docs/说明.pdf)\n\n[外部](https://example.org/)\n\n~~~mermaid\nflowchart LR\n A-->B\n~~~\n\n~~~mermaid\nflowchart LR\n A-->B\n~~~";
 const result=await prepareNoteExport(snapshot(source),{image},{decodeImage});
 const doc=parsed(result.html);
 expect(image).toHaveBeenCalledTimes(1);
 expect(doc.querySelectorAll("img")).toHaveLength(4);
 expect(doc.querySelectorAll("figure")).toHaveLength(2);
 expect(result.warnings.map(w=>w.message)).toEqual(expect.arrayContaining([expect.stringContaining("图片未包含或无法读取：远程"),expect.stringContaining("未包含其他笔记"),expect.stringContaining("未包含的笔记或附件")]));
 expect(result.warnings.find(w=>w.message.includes("未包含其他笔记"))?.line).toBe(7);
 expect(doc.querySelector('a[href="https://example.org/"]')).not.toBeNull();
 expect(doc.querySelector("span.export-target")?.firstChild?.textContent).toBe("别名");
 expect(doc.querySelector(".export-target-note")?.textContent).toContain("其他.md");
 expect(doc.body.textContent).toContain("笔记/docs/说明.pdf");
});
it("危险标签、协议和错误公式/图表不执行，保留源码及说明",async()=>{
 const result=await prepareNoteExport(snapshot('<script>alert(1)</script>\n\n[坏](javascript:alert(1))\n\n![坏](../../outside.png)\n\n$\\notARealCommand$\n\n~~~mermaid\nbroken\n~~~'),{image:vi.fn()},{decodeImage,diagram:async()=>{throw new Error("bad");}});
 const doc=parsed(result.html);
 expect(doc.querySelectorAll("script,object,embed")).toHaveLength(0);
 expect(doc.body.textContent).toContain("<script>alert(1)</script>");
 expect(doc.body.textContent).toContain("broken");
 expect(doc.querySelector("a")).toBeNull();
 expect(result.warnings.length).toBeGreaterThanOrEqual(4);
});
it("同篇标准链接映射文内锚点，未包含目标不伪装成可访问文件",async()=>{
 const result=await prepareNoteExport(snapshot("# 中文\n\n[自引用](中文.md#中文)\n\n[跨篇](../其他.md)\n\n[[丢失]]"),{image:vi.fn()},{decodeImage});
 const doc=parsed(result.html);
 expect(doc.querySelector("a")?.getAttribute("href")).toBe("#"+encodeURIComponent("中文"));
 expect(doc.querySelectorAll("a")).toHaveLength(1);
 expect(result.warnings.map(w=>w.message)).toEqual(expect.arrayContaining(["未包含的笔记或附件：其他.md","Wiki 目标不存在：丢失"]));
});
it("标题自然后缀、空标题与脚注保留 ID 互不碰撞，文内链接始终有唯一目标",async()=>{
 const source="# 重复\n\n# 重复\n\n# 重复-1\n\n# 重复\n\n# !!!\n\n# section\n\n# footnote-label\n\n脚注[^a]\n\n[^a]: 说明\n\n[重复](#重复-1) [后缀](#重复-1-1) [脚注标题](#footnote-label-1)";
 const result=await prepareNoteExport(snapshot(source),{image:vi.fn()},{decodeImage});
 const doc=parsed(result.html),ids=[...doc.querySelectorAll("[id]")].map(node=>node.id);
 expect(new Set(ids).size).toBe(ids.length);
 expect([...doc.querySelectorAll("h1")].map(node=>node.id)).toEqual(["重复","重复-1","重复-1-1","重复-2","section","section-1","footnote-label-1"]);
 for(const link of doc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) expect(doc.getElementById(decodeURIComponent(link.getAttribute("href")!.slice(1)))).not.toBeNull();
 expect(result.warnings).toEqual([]);
});
it("离线正文保留链接标签、目标与缺失/歧义说明，不注入绝对路径或可执行链接",async()=>{
 const input=snapshot('[**跨篇**](../其他.md#章节)\n\n[附件](docs/说明.pdf)\n\n[[同名|别名]]\n\n[[未找到|缺失]]\n\n[[C:/secret/note|无效]]\n\n[[&lt;img&gt;|转义]]\n\n[本页](中文.md) [[中文|自己]] [顶部](#)');
 input.paths.push("一/同名.md","二/同名.md");
 const result=await prepareNoteExport(input,{image:vi.fn()},{decodeImage}),doc=parsed(result.html);
 expect(doc.querySelector(".export-target strong")?.textContent).toBe("跨篇");
 expect(doc.body.textContent).toContain("其他.md#章节");
 expect(doc.body.textContent).toContain("笔记/docs/说明.pdf");
 expect(doc.body.textContent).toContain("别名（Wiki 目标有歧义：同名）");
 expect(doc.body.textContent).toContain("缺失（Wiki 目标不存在：未找到）");
 expect(doc.body.textContent).toContain("无效（不支持或无效的 Wiki 目标）");
 expect(doc.body.textContent).not.toContain("C:/secret/note");
 expect(doc.body.textContent).toContain("Wiki 目标不存在：<img>");
 expect(doc.querySelector("img")).toBeNull();
 expect([...doc.querySelectorAll("a")].map(link=>link.getAttribute("href"))).toEqual(["#","#","#"]);
 expect(result.warnings.some(item=>item.message.includes("文内锚点不存在"))).toBe(false);
});
it("取消在途资源后拒绝旧结果，超限不生成部分成品",async()=>{
 const controller=new AbortController();
 let deliver!:(value:string)=>void;
 const image=vi.fn(()=>new Promise<string>(resolve=>{deliver=resolve;}));
 const promise=prepareNoteExport(snapshot("![图](a.png)"),{image},{decodeImage,signal:controller.signal});
 await vi.waitFor(()=>expect(image).toHaveBeenCalled());
 controller.abort();deliver(png);
 await expect(promise).rejects.toMatchObject({name:"AbortError"});
 await expect(prepareNoteExport(snapshot("正文"),{image},{decodeImage,maxBytes:100})).rejects.toThrow("上限");
});
it("Wiki 同篇标题使用冻结正文的真实 Unicode/重复/脚注避让 ID，跨篇保留片段且不读取其他笔记",async()=>{
 const content="# 重复\n\n# 重复\n\n# 重复-1\n\n# footnote-label\n\n脚注[^a]\n\n[^a]: 说明\n\n[[#重复-1|第二个]] [[中文.md#重复-1-1|自然后缀]] [[#footnote-label-1|避让]] [[#新标题|未保存]]\n\n# 新标题\n\n[[其他#章节|跨篇]] [[#丢失|缺失]] [[#^块|块引用]]";
 const input=snapshot(content),api={image:vi.fn(),read:vi.fn()};
 const result=await prepareNoteExport(input,api,{decodeImage}),doc=parsed(result.html);
 expect([...doc.querySelectorAll("a")].filter(a=>!a.classList.contains("data-footnote-backref")).map(a=>a.getAttribute("href"))).toEqual(expect.arrayContaining(["#"+encodeURIComponent("重复-1"),"#"+encodeURIComponent("重复-1-1"),"#footnote-label-1","#"+encodeURIComponent("新标题")]));
 for(const link of doc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))expect(doc.getElementById(decodeURIComponent(link.getAttribute("href")!.slice(1)))).not.toBeNull();
 expect(doc.body.textContent).toContain("跨篇（未包含其他笔记：其他.md#章节）");
 expect(result.warnings.map(item=>item.message)).toEqual(expect.arrayContaining(["未包含其他笔记：其他.md#章节","文内标题不存在：丢失","不支持的 Wiki 链接片段：#^块"]));
 expect(api.read).not.toHaveBeenCalled();expect(api.image).not.toHaveBeenCalled();
});
it("导出文件名保留中文并限制保留名、路径分隔及无效字符",()=>{
 expect(exportFileName("年/月/中文.md")).toBe("中文.html");
 expect(exportFileName("CON.md")).toBe("_CON.html");
 expect(exportFileName('a:x?*.md')).toBe("a_x__.html");
 expect(exportFileName(".md")).toBe("笔记.html");
});
it("SVG 图片拒绝交互和外部资源，只允许自包含图片类型",()=>{
 expect(safeExportImage(png)).toBe(png);
 expect(()=>safeExportImage("data:text/html;base64,aGVsbG8=")).toThrow();
 expect(()=>safeExportImage("data:image/svg+xml;base64,"+base64Text('<svg><script>alert(1)</script></svg>'))).toThrow();
 expect(()=>safeExportImage("data:image/svg+xml;base64,"+base64Text('<svg><use href="https://example.org/a.svg"/></svg>'))).toThrow();
});
it("资源超时给出失败而不是永远等待",async()=>{
 await expect(bounded(new Promise(()=>{}),undefined,5)).rejects.toThrow("超时");
});
it("万字、20 图、多公式图表和长表代码的模型样本保持完整并去重资源",async()=>{
 const chinese="本地知识管理需要保持正文链接公式图表与草稿完整。".repeat(500).slice(0,10000);
 const paragraphs=Array.from({length:20},(_,i)=>"## 章节 "+i+"\n\n"+chinese.slice(i*500,(i+1)*500));
 const images=Array.from({length:20},(_,i)=>"![示例 "+i+"](attachments/图-"+(i%10)+".png)");
 const math=Array.from({length:10},(_,i)=>"$$\nx_{"+i+"}^2 + \\frac{1}{2}\n$$");
 const diagrams=Array.from({length:3},()=>"~~~mermaid\nflowchart LR\n A-->B\n~~~");
 const table="| 名称 | 值 |\n| --- | --- |\n"+Array.from({length:80},(_,i)=>"| 行 "+i+" | 中文值 |").join("\n");
 const code="~~~rust\n"+Array.from({length:120},(_,i)=>"let value_"+i+" = "+i+";").join("\n")+"\n~~~";
 const input=snapshot([...paragraphs,...images,...math,...diagrams,table,code].join("\n\n")),image=vi.fn(async()=>"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1QAAAAASUVORK5CYII=");
 const began=performance.now(),result=await prepareNoteExport(input,{image},{decodeImage}),elapsedMs=Math.round(performance.now()-began),doc=parsed(result.html);
 expect(doc.body.textContent).toContain(chinese.slice(-500));
 expect(doc.querySelectorAll("img")).toHaveLength(23);
 expect(doc.querySelectorAll(".katex")).toHaveLength(10);
 expect(doc.querySelectorAll("tbody tr")).toHaveLength(80);
 expect(doc.querySelector("pre code")?.textContent).toContain("let value_119 = 119;");
 expect(image).toHaveBeenCalledTimes(10);
 expect(result.warnings).toEqual([]);
 console.info("stage44-scale",JSON.stringify({sourceCharacters:input.content.length,htmlBytes:result.bytes,elapsedMs,images:20,uniqueImages:10,formulas:10,diagrams:3,tableRows:80,codeLines:120,decode:"mock",diagram:"mock"}));
},30000);
