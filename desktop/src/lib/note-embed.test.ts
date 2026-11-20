import {describe,it,expect,vi} from "vitest";
import {embedSection,loadNoteEmbeds,parseNoteEmbeds,resolveEmbed} from "./note-embed";
import {KnowledgeIndex} from "./knowledge";
import {rewriteNoteLinks} from "./relocate-notes";

describe("笔记嵌入模型",()=>{
 it("保留来源位置、别名及独占行，排除代码、转义和标准图片",()=>{
  const source="![[目录/a.md#标题|显示]]\n\n文字 ![[b]]\n\n`![[c]]`\n\n\\![[d]]\n\n![e](e.png)\n\n```\n![[f]]\n```";
  const hits=parseNoteEmbeds(source);
  expect(hits.map(hit=>[hit.target,hit.label,hit.standalone])).toEqual([["目录/a.md#标题","显示",true],["b","b",false]]);
  expect(source.slice(hits[0].from,hits[0].to)).toBe("![[目录/a.md#标题|显示]]");
 });
 it("沿用文件优先和同名歧义，拒绝循环与块引用",()=>{
  const paths=["源.md","目录/a#b.md","目录/a.md","x/同名.md","y/同名.md"];
  expect(resolveEmbed("目录/a#b.md","源.md",paths)).toMatchObject({path:"目录/a#b.md",fragment:null});
  expect(resolveEmbed("目录/a#b.md#章节","源.md",paths)).toMatchObject({path:"目录/a#b.md",fragment:"章节"});
  expect(resolveEmbed("同名","源.md",paths).error).toBe("存在同名笔记");
  expect(resolveEmbed("#章节","源.md",paths).error).toBe("不能嵌入当前笔记");
  expect(resolveEmbed("目录/a#^块","源.md",paths).error).toContain("无效块 ID");
  expect(resolveEmbed("图片.png","源.md",paths).error).toContain("不支持");
 });
 it("跨篇块嵌入按真实块边界提取，拒绝重复 ID",()=>{
  expect(embedSection("正文 ^one\n\n另一段 ^two","^one").content).toBe("正文 ");
  expect(embedSection("- 父 ^item\n  - 子\n- 其他","^item").content).toBe("- 父 \n  - 子");
  expect(embedSection("- 根\n  - 父\n    - 深层 ^deep\n      - 子\n  - 其他","^deep").content).toBe("- 深层 \n  - 子");
  expect(embedSection("正文 ^id\n\n重复 ^ID","^id").error).toContain("重复");
 });
 it("块嵌入带入同文件内的脚注和链接定义",()=>{
  const source="参考[^a] 与 [资料][x] ^p\n\n[^a]: 脚注内容\n\n[x]: 文档.md\n\n其他正文";
  const result=embedSection(source,"^p");expect(result.content).toContain("[^a]: 脚注内容");expect(result.content).toContain("[x]: 文档.md");expect(result.content).not.toContain("其他正文");
 });
 it("通过现有标题 ID 切分并保留下级标题",()=>{
  const source="# 开始\n\n## 重复\n\n内容\n\n### 子项\n\n子内容\n\n## 重复\n\n第二节\n\n# 结束";
  expect(embedSection(source,"重复").content).toBe("## 重复\n\n内容\n\n### 子项\n\n子内容\n\n");
  expect(embedSection(source,"重复-1").content).toBe("## 重复\n\n第二节\n\n");
  expect(embedSection(source,"不存在").error).toBe("文件存在，标题不存在");
 });
 it("setext 标题可截取，引用中的标题保守拒绝",()=>{
  expect(embedSection("标题\n====\n\n正文\n\n下一项\n====\n", "标题").content).toBe("标题\n====\n\n正文\n\n");
  expect(embedSection("> # 引用标题\n> 文字\n", "引用标题").error).toBe("嵌套标题无法安全提取");
 });
 it("嵌入进入关联并在目标移动时保留前缀、标题和别名",()=>{
  const source="![[目录/笔记.md#章节|显示]]\n\n`![[目录/笔记.md]]`\n\n![[图片.png]]";
  const paths=["首页.md","目录/笔记.md"];
  const index=new KnowledgeIndex().build(paths,[{path:"首页.md",content:source,version:"1"},{path:"目录/笔记.md",content:"# 章节\n正文",version:"1"}]);
  expect(index.references).toHaveLength(1);
  expect(index.references[0]).toMatchObject({kind:"embed",target:"目录/笔记.md",heading:{status:"resolved"}});
  expect(rewriteNoteLinks(source,"首页.md","首页.md",[{from:"目录/笔记.md",to:"归档/笔记.md"}],paths)).toBe("![[归档/笔记.md#章节|显示]]\n\n`![[目录/笔记.md]]`\n\n![[图片.png]]");
 });
 it("读取保存态时复用同一目标并分别提取标题和报告错误",async()=>{
  const read=vi.fn(async(path:string)=>({path,content:"# 标题\n内容\n# 其他\n内容",version:"1"}));
  const result=await loadNoteEmbeds("![[目标]]\n\n![[目标#标题]]\n\n![[丢失]]","源.md",["源.md","目标.md"],read);
  expect(read).toHaveBeenCalledTimes(1);
  expect(result?.map(item=>item.content??item.error)).toEqual(["# 标题\n内容\n# 其他\n内容","# 标题\n内容\n","笔记不存在"]);
 });
 it("库变化后丢弃迟到结果",async()=>{
  let finish!:(value:{path:string;content:string;version:string})=>void,stale=false;
  const pending=loadNoteEmbeds("![[目标]]","源.md",["源.md","目标.md"],()=>new Promise(resolve=>{finish=resolve;}),()=>stale);
  stale=true;finish({path:"目标.md",content:"正文",version:"1"});
  expect(await pending).toBeNull();
 });
 it("每个宿主超过一百处的嵌入明确提示并复用目标读取",async()=>{
  const read=vi.fn(async(path:string)=>({path,content:"正文",version:"1"}));
  const result=await loadNoteEmbeds(Array.from({length:101},()=>"![[目标]]").join("\n\n"),"源.md",["源.md","目标.md"],read);
  expect(result).toHaveLength(101);expect(result?.[99].content).toBe("正文");expect(result?.[100].error).toContain("超过上限");expect(read).toHaveBeenCalledTimes(1);
 });
});
