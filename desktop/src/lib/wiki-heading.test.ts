import {describe,expect,it} from "vitest";
import {headingIndex,findHeading} from "./heading-index";
import {resolveWikiTarget,formatWikiHeading,wikiFileRange} from "./wiki-target";
import {parseKnowledge,KnowledgeIndex,referenceHasIssue,referenceIssueText} from "./knowledge";
import {rewriteNoteLinks} from "./relocate-notes";
import {buildGraph} from "./knowledge-graph";
const paths=["a.md","folder/a.md","folder/记录#实验.md","literal%20.md","literal .md","a#重复.md","b.markdown"];
describe("Wiki 标题语义",()=>{
 it("完整文件优先，带扩展名标题可区分，最长实际前缀保留字面 # 和 %",()=>{
  expect(resolveWikiTarget("a#重复","b.markdown",paths)).toMatchObject({fragment:null,candidates:["a#重复.md"]});
  expect(resolveWikiTarget("./a.md#重复","b.markdown",paths)).toMatchObject({fragment:"重复",candidates:["a.md"]});
  expect(resolveWikiTarget("folder/记录#实验.md#结果","b.markdown",paths)).toMatchObject({file:"folder/记录#实验.md",fragment:"结果",candidates:["folder/记录#实验.md"]});
  expect(resolveWikiTarget("literal%20#标题","b.markdown",paths)).toMatchObject({candidates:["literal%20.md"],fragment:"标题"});
 });
 it("同篇以显式来源定位，画布来源不冒用活动笔记，歧义保留",()=>{
  expect(resolveWikiTarget("#标题","folder/a.md",paths)).toMatchObject({file:"",fragment:"标题",candidates:["folder/a.md"],invalid:false});
  expect(resolveWikiTarget("#标题","x.canvas",paths)).toMatchObject({invalid:true,candidates:[]});
  expect(resolveWikiTarget("a#不存在","b.markdown",paths).candidates).toEqual(["a.md","folder/a.md"]);
  expect(resolveWikiTarget("../a#标题","b.markdown",paths).invalid).toBe(true);
  expect(resolveWikiTarget("C:/a#标题","b.markdown",paths).invalid).toBe(true);
 });
 it("标题索引保持格式化/setext/别名文字、重复及脚注冲突，排除伪标题",()=>{
  const source="# 重复\n\n# 重复\n\n# 重复-1\n\n# !!!\n\n# section\n\n# footnote-label\n\n## [[a|可读名称]] 与 **粗体**\n\nSetext\n---\n\n脚注[^x]\n\n[^x]: 正文\n\n~~~md\n# 伪标题\n~~~\n\n$$\n# 公式\n$$";
  const headings=headingIndex(source);
  expect(headings.map(h=>h.id)).toEqual(["重复","重复-1","重复-1-1","section","section-1","footnote-label-1","可读名称-与-粗体","setext"]);
  expect(headings.every(h=>source.slice(h.from).split("\n")[0].length>0)).toBe(true);
  expect(headings.at(-1)).toMatchObject({text:"Setext",level:2});
  expect(findHeading(headings,"重复-1")?.from).toBe(headings[1].from);
  expect(findHeading(headings,"Setext")?.id).toBe("setext");
  expect(findHeading(headings,"^block")).toBeUndefined();
 });
 it("规范复制能往返 Markdown 保留符号和同名/根目录路径",()=>{
  const heading={id:"重复-1",text:"可读 [名称] | *原文*"};
  const text=formatWikiHeading("a.md",heading,paths);
  const link=parseKnowledge(text).wiki[0];
  expect(link).toBeDefined();
  expect(link.label).toBe(heading.text);
  expect(resolveWikiTarget(link.target,"b.markdown",paths)).toMatchObject({fragment:"重复-1",candidates:["a.md"]});
  expect(()=>formatWikiHeading("a.md",heading,[...paths,"a.md#重复-1.md"])).toThrow(/冲突/);
  expect(()=>formatWikiHeading("a.md",{id:"url",text:"https://example.test"},paths)).toThrow(/无法安全/);
 });
 it("只映射原文件范围，转义/实体标题和别名保持字节不变",()=>{
  const source="前 [[&#65; #标题 &#35; 细节|&#91;别名&#93;]] 后";
  const link=parseKnowledge(source).wiki[0];
  const range=wikiFileRange(source,link,"A");
  expect(source.slice(range.from,range.to)).toBe("&#65;");
  const after=rewriteNoteLinks(source,"source.md","source.md",[{from:"A.md",to:"新/B.md"}],["A.md","source.md"]);
  expect(after).toBe("前 [[新/B.md #标题 &#35; 细节|&#91;别名&#93;]] 后");
 });
 it("移动后文件 # 碰撞拒绝迁移，自己标题的另存不改",()=>{
  expect(rewriteNoteLinks("[[#标题|自己]]","a.md","另存.md",[],paths)).toBe("[[#标题|自己]]");
  expect(()=>rewriteNoteLinks("[[./a.md#标题]]","b.markdown","b.markdown",[{from:"a.md",to:"c.md"}],["a.md","b.markdown","c.md#标题.md"])).toThrow(/冲突/);
 });
});
describe("保存后的标题诊断与文件关系",()=>{
 it("标题缺失和旧片段不消除文件级边，未读与失败不使用旧缓存",()=>{
  const index=new KnowledgeIndex(),files=["a.md","b.md"];
  const source={path:"a.md",content:"[[b#存在]] [[b#缺失]] [[b#^old]] [[#本篇]]",version:"v1"};
  const target={path:"b.md",content:"# 存在",version:"v1"};
  const full=index.build(files,[source,target]);
  expect(full.references.map(r=>[r.status,r.heading?.status])).toEqual([["resolved","resolved"],["resolved","missing"],["resolved","invalid"],["resolved","missing"]]);
  expect(buildGraph(full).edges).toHaveLength(1);
  expect(full.references.filter(referenceHasIssue)).toHaveLength(3);
  expect(referenceIssueText(full.references[1])).toBe("文件存在，标题不存在");
  const unread=index.build(files,[source]);
  expect(unread.references[0].heading?.status).toBe("unknown");
  const changed=index.build(files,[source,{...target,content:"# 新标题",version:"v2"}]);
  expect(changed.references[0].heading?.status).toBe("missing");
 });
});
