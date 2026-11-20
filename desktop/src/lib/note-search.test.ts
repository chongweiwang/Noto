import {describe,expect,it} from "vitest";
import {collectSearch,createSearchHit,literalMatches,resolveSearchHit,rawSearchOffset,sourceSearchOffset} from "./note-search";
import {previewSearch} from "./search-preview";
const note=(content:string,path="笔记.md")=>({path,content,version:"v1"});
describe("精确字面搜索",()=>{
 it("同一行和多行分别记录 UTF-16 位置、码点列号和路径匹配",async()=>{
  const source="😀 电流 电流\r\n电流",result=await collectSearch("电流",[note(source,"电流.md")],["电流.md"]);
  expect(result?.hits).toBe(3);const file=result!.files[0];expect(file.pathMatched).toBe(true);
  expect(file.hits.map(h=>[h.from,h.to,h.line,h.column])).toEqual([[3,5,1,3],[6,8,1,6],[10,12,2,1]]);
  expect(file.hits.every(h=>source.slice(h.from,h.to)===h.text)).toBe(true);
 });
 it("转义正则字符，Unicode 匹配不会把小写展开偏移当成原串位置",()=>{
  expect(literalMatches("a.b aXb a.b","a.b").ranges).toEqual([{from:0,to:3},{from:8,to:11}]);
  expect(literalMatches("[] $ ^ ?","[]").ranges).toEqual([{from:0,to:2}]);
  expect(literalMatches("İ ZZZ ı I i","zzz").ranges[0]).toEqual({from:2,to:5});
  expect(literalMatches("😀a😀A","a").ranges).toEqual([{from:2,to:3},{from:5,to:6}]);
  expect(literalMatches("aaaa","aa").ranges).toEqual([{from:0,to:2},{from:2,to:4}]);
 });
 it("长行摘要围绕命中且不拆代理对，空查询不扫描",async()=>{
  const source="前".repeat(250)+"😀MATCH😀"+"后".repeat(250),hit=createSearchHit(source,literalMatches(source,"match").ranges[0]);
  expect(hit.snippet.text.slice(hit.snippet.from,hit.snippet.to)).toBe("MATCH");expect(hit.snippet.leading&&hit.snippet.trailing).toBe(true);
  expect(hit.snippet.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  expect((await collectSearch(" ",[note(source)],["笔记.md"]))?.files).toEqual([]);
 });
 it("不可读文件仍可按路径显示，画布/白板不进入正文搜索",async()=>{
  const result=await collectSearch("目标",[],["目标.md","目标.canvas","目标.drawing"]);
  expect(result!.files).toMatchObject([{path:"目标.md",unread:true,pathMatched:true,hits:[]}]);
 });
 it("收集/文件上限与未扫描分开，协作取消丢弃结果",async()=>{
  const notes=[note("x x x x","a.md"),note("x x","b.md"),note("x","c.md")],result=await collectSearch("x",notes,notes.map(n=>n.path),()=>false,{perFile:2,total:3});
  expect(result).toMatchObject({hits:3,truncated:true,unscanned:1});expect(result!.files[0].truncated).toBe(true);
  let cancel=false;const paths=Array.from({length:40},(_,i)=>i+".md");
  expect(await collectSearch("x",paths.map(path=>note("x",path)),paths,()=>cancel,{yield:async()=>{cancel=true;}})).toBeNull();
 });
});
describe("新内容与换行映射",()=>{
 it.each(["\n","\r\n","\r"])("换行 %j 的选择可映射至编辑器 LF，并从快照重定位",eol=>{
  const source="第一行"+eol+"命中"+eol+"尾行",n=note(source),hit=createSearchHit(source,literalMatches(source,"命中").ranges[0]);
  expect(rawSearchOffset(source,hit.from)).toBe(4);expect(sourceSearchOffset(source,4)).toBe(hit.from);
  expect(resolveSearchHit(n,hit,source.replace(/\r\n?|\n/g,"\n"),"命中")).toEqual({from:4,to:6});
 });
 it("正文前插入内容时按完整上下文唯一重定位，不猜同词或重复上下文",()=>{
  const source="## 原始标题\n\n这是唯一上下文的命中以及结束。",n=note(source),hit=createSearchHit(source,literalMatches(source,"命中").ranges[0]);
  expect(resolveSearchHit(n,hit,"新增\n\n"+source,"命中")).toEqual({from:hit.from+4,to:hit.to+4});
  expect(resolveSearchHit(n,hit,"原段落已删，另一处命中","命中")).toBeNull();
  expect(resolveSearchHit(n,hit,source+"\n\n"+source,"命中")).toBeNull();
 });
});
describe("阅读位置投影",()=>{
 const project=(content:string,query:string,ordinal=0)=>{const range=literalMatches(content,query).ranges[ordinal];return previewSearch(content,{path:"笔记.md",content,...range,serial:1,query});};
 it("普通文字、格式、实体和转义按实际文本映射，隐藏源码按块降级",()=>{
  expect(project("**重复**\n\n重复","重复",1)?.exact).toMatchObject({kind:"text",from:0,to:2});
  expect(project("前 &amp; 后","&amp;")?.exact).toMatchObject({from:2,to:3});
  expect(project("前 &amp; 后","amp")?.exact).toBeUndefined();
  expect(project("[标签](url/target)","target")).toMatchObject({block:{tag:"p"}});
  expect(project("[标签](url/target)","target")?.exact).toBeUndefined();
  expect(project("[[文件#标题|别名]]","标题")?.exact).toBeUndefined();
 });
 it("行内代码和普通围栏可投影，公式/Mermaid 源码保留块定位",()=>{
  expect(project("`const xx`","xx")?.exact).toMatchObject({kind:"code",from:6,to:8});
  expect(project("~~~js\r\nconst xx = 1;\r\n~~~","xx")?.exact).toMatchObject({kind:"code",from:6,to:8});
  expect(project("~~~mermaid\nflowchart LR\n A-->B\n~~~","flowchart")).toMatchObject({block:{tag:"pre"}});
  expect(project("$$\nx^2\n$$","x")?.exact).toBeUndefined();
 });
});
