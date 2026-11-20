// @vitest-environment jsdom
import "../test/codemirror-dom";
import {act,cleanup,fireEvent,render,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {EditorState,Compartment} from "@codemirror/state";
import {EditorView} from "@codemirror/view";
import {CompletionContext,acceptCompletion,startCompletion,type CompletionResult} from "@codemirror/autocomplete";
import {MarkdownEditor} from "./markdown-editor";
import {wikiCompletionSource,wikiConfigFacet,type WikiConfig} from "./noteriv-markdown/wikilinks";
import {headingIndex} from "../lib/heading-index";
import {blockIndex} from "../lib/wiki-block";
import type {WikiServices} from "../lib/wiki-ui";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
afterEach(cleanup);
function model(doc:string,pos=doc.length,config:Partial<WikiConfig>={}){
 const compartment=new Compartment(),parent=document.createElement("div");document.body.appendChild(parent);
 const view=new EditorView({parent,state:EditorState.create({doc,selection:{anchor:pos},extensions:[compartment.of(wikiConfigFacet.of({paths:["源.md","目标.md"],notePath:"源.md",onOpen:()=>{},...config}))]})});
 const context=new CompletionContext(view.state,pos,true,view);
 return {view,context,result:()=>wikiCompletionSource(context),apply:(result:CompletionResult,index=0)=>{const option=result.options[index];if(typeof option.apply!=="function")throw Error("expected apply");option.apply(view,option,result.from,result.to??pos);},destroy:()=>{view.destroy();parent.remove();},changeConfig:(value:WikiConfig)=>view.dispatch({effects:compartment.reconfigure(wikiConfigFacet.of(value))})};
}
function services(source="# 重复\n\n## 重复\n\n## 重复-1"):WikiServices{
 return {load:vi.fn(async()=>({path:"目标.md",headings:headingIndex(source)})),lookup:()=>undefined,feedback:vi.fn()};
}
it("块补全只列出已有且唯一的标记并保留别名",async()=>{
 const api=services();api.loadBlocks=vi.fn(async()=>({path:"目标.md",blocks:blockIndex("目标正文 ^good\n\n重复 ^dup\n\n重复二 ^DUP")}));
 const doc="[[目标#^|原别名]] 邻近正文",pos=doc.indexOf("|");const m=model(doc,pos,{services:api});
 try{const result=await m.result();expect(result?.options.map(option=>option.label)).toEqual(["good"]);m.apply(result!);expect(m.view.state.doc.toString()).toBe("[[./目标.md#^good|原别名]] 邻近正文");expect(api.loadBlocks).toHaveBeenCalledWith("目标#^","源.md");}finally{m.destroy();}
});
it("真实编辑器在 # 后异步补全重名标题，保留原别名、右括号和相邻文本",async()=>{
 const value="[[目标#|&#91;原别名&#93;]] 邻近正文",api=services();
 const {container}=render(<MarkdownEditor value={value} notePath="源.md" wikiPaths={["源.md","目标.md"]} wikiServices={api} disabled={false} live onChange={()=>{}} onSave={()=>{}} onSaveAs={()=>{}} onImport={()=>{}}/>);
 const view=EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
 act(()=>{view.dispatch({selection:{anchor:value.indexOf("|")}});view.focus();startCompletion(view);});
 await waitFor(()=>expect(container.querySelector(".cm-tooltip-autocomplete")?.textContent).toContain("#重复-1-1"));
 await new Promise(resolve=>setTimeout(resolve,100));
 // The second heading is distinct even though its readable label is repeated.
 fireEvent.keyDown(view.contentDOM,{key:"ArrowDown",code:"ArrowDown"});
 act(()=>{acceptCompletion(view);});
 expect(view.state.doc.toString()).toBe("[[./目标.md#重复-1|&#91;原别名&#93;]] 邻近正文");
 expect(api.load).toHaveBeenCalledWith("目标#","源.md");
});
it("同篇标题读取实时正文，规范路径不被同名子目录误选，候选限制为 50",async()=>{
 const content="# 本篇\n\n[[#",m=model(content,content.length,{paths:["源.md","目录/源.md"]});
 try{
  const result=await m.result();expect(result?.options[0].label).toBe("本篇");m.apply(result!);
  expect(m.view.state.doc.toString()).toBe("# 本篇\n\n[[./源.md#本篇|本篇]]");
 }finally{m.destroy();}
 const api=services(Array.from({length:80},(_,i)=>"# 标题"+i).join("\n\n")),many=model("[[目标#",undefined,{services:api});
 try{const result=await many.result();expect(result?.options).toHaveLength(50);expect(api.feedback).toHaveBeenLastCalledWith("标题补全：50 / 80 项","源.md");}finally{many.destroy();}
});
it.each([
 ["[[目标#]] 邻近正文","[[./目标.md#重复|重复]] 邻近正文"],
 ["[[目标#|原别名","[[./目标.md#重复|原别名]]"],
 ["[[目标# 邻近正文","[[./目标.md#重复|重复]] 邻近正文"],
])("补全保护已闭合和未闭合文本：%s",async(doc,expected)=>{
 const pos=doc.indexOf("#")+1,m=model(doc,pos,{services:services()});
 try{const result=await m.result();m.apply(result!);expect(m.view.state.doc.toString()).toBe(expected);}finally{m.destroy();}
});
it("迟到的补全不改写已输入、已移动光标、隐藏标签、变化路径或新开始的组字",async()=>{
 for(const action of ["doc","cursor","hidden","paths","compose"]){
  let resolve!:(value:{path:string;headings:ReturnType<typeof headingIndex>})=>void;let active=true;
  const api=services();api.load=()=>new Promise(done=>{resolve=done;});
  const m=model("[[目标#",undefined,{services:api,active:()=>active});
  try{
   const pending=m.result();
   if(action==="doc")m.view.dispatch({changes:{from:m.view.state.doc.length,insert:"输入"}});
   if(action==="cursor")m.view.dispatch({selection:{anchor:0}});
   if(action==="hidden")active=false;
   if(action==="compose")fireEvent.compositionStart(m.view.contentDOM);
   if(action==="paths")m.changeConfig({paths:["源.md","新.md"],notePath:"源.md",onOpen:()=>{},services:api});
   resolve({path:"目标.md",headings:headingIndex("# 重复")});
   const result=await pending,before=m.view.state.doc.toString();if(result)m.apply(result);
   if(action==="compose"){expect(result).toBeNull();fireEvent.compositionEnd(m.view.contentDOM);}
   expect(m.view.state.doc.toString()).toBe(before);
  }finally{m.destroy();}
 }
});
it("读取错误、无匹配及不支持来源给出明确反馈；IME 不读取或插入",async()=>{
 const api=services(),m=model("[[目标#不存在",undefined,{services:api});
 try{expect((await m.result())?.options).toEqual([]);expect(api.feedback).toHaveBeenLastCalledWith("没有匹配标题","源.md");
  vi.mocked(api.load).mockRejectedValueOnce(Error("无权限"));expect(await m.result()).toBeNull();expect(api.feedback).toHaveBeenLastCalledWith("标题补全：无权限","源.md");
  fireEvent.compositionStart(m.view.contentDOM);expect(await m.result()).toBeNull();expect(api.load).toHaveBeenCalledTimes(2);fireEvent.compositionEnd(m.view.contentDOM);
 }finally{m.destroy();}
 const canvas=model("[[#",undefined,{notePath:"空间.canvas"});
 try{expect(await canvas.result()).toBeNull();}finally{canvas.destroy();}
});
it.each(["~~~md\n[[目标#","\u0060[[目标#\u0060","\u005c[[目标#","![[目标#","$$\n[[目标#","<div>\n[[目标#"])("排除代码、转义、嵌入、数学及 HTML：%s",async(doc)=>{
 const api=services(),m=model(doc,doc.lastIndexOf("#")+1,{services:api});try{expect(await m.result()).toBeNull();expect(api.load).not.toHaveBeenCalled();}finally{m.destroy();}
});
