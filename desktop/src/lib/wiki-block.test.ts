import {describe,it,expect} from "vitest";
import {blockIndex,findBlock,planBlockMarker} from "./wiki-block";
import {formatWikiBlock,resolveWikiTarget} from "./wiki-target";
import {parseKnowledge} from "./wiki-syntax";

describe("Wiki 块索引",()=>{
 it("区分段落、多行段落、列表项及完整结构",()=>{
  const text="第一行\n第二行 ^para\n\n- 父项 ^parent\n  - 子项 ^child\n- 另一个\n\n^list\n\n> 引文\n\n^quote";
  const index=blockIndex(text);
  expect(text.slice(findBlock(index,"para").block!.from,findBlock(index,"para").block!.to)).toBe("第一行\n第二行 ^para");
  expect(text.slice(findBlock(index,"parent").block!.from,findBlock(index,"parent").block!.to)).toContain("子项 ^child");
  expect(findBlock(index,"child").block?.kind).toBe("listItem");expect(findBlock(index,"list").block?.kind).toBe("list");expect(findBlock(index,"quote").block?.kind).toBe("blockquote");
 });
 it("重复 ID 与同一块多个 ID 不猜目标",()=>{
  const index=blockIndex("一 ^ABC\n\n二 ^abc\n\n三 ^x\n\n^y");
  expect(findBlock(index,"abc").status).toBe("ambiguous");expect(findBlock(index,"x").status).toBe("ambiguous");expect(findBlock(index,"y").status).toBe("ambiguous");
  expect(findBlock(index,"?").status).toBe("invalid");expect(findBlock(index,"missing").status).toBe("missing");
 });
 it("排除代码、数学、HTML、链接、转义和 frontmatter",()=>{
  const source="---\nkey: ^yaml\n---\n\n`代码 ^a`\n\n$公式 ^b$\n\n[链接 ^c](https://x)\n\n\\^d\n\n<div>\n文本 ^e\n</div>\n\n```\n文本 ^f\n```\n\n正文 ^ok";
  const index=blockIndex(source);for(const id of ["yaml","a","b","c","d","e","f"])expect(findBlock(index,id).status).toBe("missing");expect(findBlock(index,"ok").status).toBe("resolved");
 });
 it("处理 CRLF、非 ASCII 正文与表格独立标记",()=>{
  const source="| 名称 | 值 |\r\n| --- | --- |\r\n| 😀 | 1 |\r\n\r\n^table-1\r\n";
  const block=findBlock(blockIndex(source),"TABLE-1").block!;expect(block.kind).toBe("table");expect(source.slice(block.from,block.to)).toContain("😀");
 });
 it("紧邻前文的独立标记仍绑定当前段落",()=>{
  const source="段落\n^near\n\n下一段";const block=findBlock(blockIndex(source),"near").block!;
  expect(block.kind).toBe("paragraph");expect(source.slice(block.from,block.to)).toBe("段落\n^near");
 });
 it("保存态关系区分块存在、缺失、重复和未读",async()=>{
  const {KnowledgeIndex}=await import("./knowledge"),paths=["a.md","b.md"];
  const source={path:"a.md",content:"[[b#^yes]] [[b#^missing]] [[b#^dup]]",version:"1"};
  const target={path:"b.md",content:"正确 ^yes\n\n重复 ^dup\n\n重复二 ^DUP",version:"1"};
  const index=new KnowledgeIndex();
  expect(index.build(paths,[source,target]).references.map(ref=>ref.heading?.status)).toEqual(["resolved","missing","ambiguous"]);
  expect(index.build(paths,[source]).references.map(ref=>ref.heading?.status)).toEqual(["unknown","unknown","unknown"]);
 });
 it("显式创建时生成唯一标记，已有 ID 不重复插入，跨块选区拒绝",()=>{
  const source="第一段\n\n第二段 ^existing",plan=planBlockMarker(source,1,1,bytes=>bytes.fill(7));
  expect(plan.change).toEqual({from:3,insert:" ^b-"+"07".repeat(16)});
  expect(planBlockMarker(source,8,8).id).toBe("existing");
  expect(()=>planBlockMarker(source,0,source.length)).toThrow(/单个块/);
  expect(()=>planBlockMarker("重复 ^a\n\n重复 ^A",1,1)).toThrow(/重复/);
  const link=formatWikiBlock("源.md",plan.id,plan.snippet,["源.md"]),target=parseKnowledge(link).wiki[0].target;
  expect(resolveWikiTarget(target,"源.md",["源.md"])).toMatchObject({fragment:"^"+plan.id,candidates:["源.md"]});
 });
});
