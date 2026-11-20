// @vitest-environment jsdom
import "../test/codemirror-dom";
import {createRef} from "react";
import {act,cleanup,fireEvent,render,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {EditorView} from "@codemirror/view";
import {MarkdownPreview} from "./markdown-preview";
import {MarkdownEditor,type EditorHandle} from "./markdown-editor";
import {editorSearchMark} from "./search-decoration";
import {literalMatches,type SearchHighlight} from "../lib/note-search";
import {prepareNoteExport} from "../lib/note-export";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
beforeEach(()=>Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function highlight(content:string,query:string,ordinal=0,serial=1):SearchHighlight{return {path:"笔记.md",content,query,...literalMatches(content,query).ranges[ordinal],serial};}
it.each([
 ["第一处 **命中**\n\n另一个命中","命中",1],
 ["> 引用命中\n\n- 列表命中","命中",1],
 ["标题命中\n===\n\n正文","命中",0],
 ["前 &amp; 后","&amp;",0],
 ["前 \\*星号\\* 后","\\*星号\\*",0],
 ["`const needle`","needle",0],
 ["~~~js\nconst needle = 1; needle;\n~~~","needle",1],
 ["正文 ^unique","unique",0],
])("阅读对实际文本投影 %s，位置只消费一次",async(content,query,ordinal)=>{
 const located=vi.fn(),match=highlight(content,query,ordinal);
 const {container,rerender}=render(<MarkdownPreview note="笔记.md" content={content} onError={()=>{}} searchHighlight={match} onSearchLocated={located}/>);
 await waitFor(()=>expect(located).toHaveBeenCalledWith(1,"exact"));
 expect(container.querySelector(".search-hit-mark")).toBeTruthy();const count=vi.mocked(HTMLElement.prototype.scrollIntoView).mock.calls.length;
 rerender(<MarkdownPreview note="笔记.md" content={content} onError={()=>{}} searchHighlight={{...match}} onSearchLocated={located}/>);
 await new Promise(resolve=>setTimeout(resolve,30));expect(vi.mocked(HTMLElement.prototype.scrollIntoView)).toHaveBeenCalledTimes(count);
});
it.each([
 ["[[文件#隐藏标题|别名]]","隐藏标题","source"],
 ["[显示文字](hidden-url)","hidden-url","source"],
 ["前 &amp; 后","amp","source"],
 ["$$\nx^2\n$$","x","source"],
 ["~~~mermaid\nflowchart LR\n A-->B\n~~~","flowchart","source"],
 ["<div>隐藏</div>","隐藏","missing"],
])("阅读不可见的原文匹配 %s 不高亮别处同词",async(content,query,status)=>{
 const located=vi.fn(),{container}=render(<MarkdownPreview note="笔记.md" content={content} onError={()=>{}} searchHighlight={highlight(content,query)} onSearchLocated={located}/>);
 await waitFor(()=>expect(located).toHaveBeenCalledWith(1,status));expect(container.querySelector(".search-hit-mark")).toBeNull();
 if(query==="x")expect(container.querySelector(".katex")).toBeTruthy();
 if(query==="flowchart")await waitFor(()=>expect(container.querySelector(".mermaid-diagram svg")).toBeTruthy());
});
it("高亮保持标题 ID、脚注、链接和代码复制文本，导出不含临时标记",async()=>{
 const source="# 重复\n\n# 重复\n\n脚注[^x]\n\n[^x]: 说明\n\n~~~js\nconst needle = 1;\n~~~",onError=vi.fn();
 const {container}=render(<MarkdownPreview note="笔记.md" content={source} onError={onError} searchHighlight={highlight(source,"needle")}/>);
 expect([...container.querySelectorAll("h1")].map(h=>h.id)).toEqual(["重复","重复-1"]);expect(container.querySelector("pre code")?.textContent).toBe("const needle = 1;\n");
 const result=await prepareNoteExport({path:"笔记.md",content:source,unsaved:false,conflict:false,paths:["笔记.md"],drawingPaths:[],capturedAt:1},{image:vi.fn()},{decodeImage:async()=>{}});
 expect(result.html).not.toMatch(/data-search-|search-hit-mark|cm-vault-search/);expect(result.html).toContain("needle");expect(onError).not.toHaveBeenCalled();
});
it("外部 CRLF 内容同步不回传用户编辑，原实例仍可揭示新范围",()=>{
 const ref=createRef<EditorHandle>(),change=vi.fn(),props={notePath:"笔记.md",disabled:false,live:true,onChange:change,onSave:()=>{},onSaveAs:()=>{},onImport:()=>{}};
 const {container,rerender}=render(<MarkdownEditor ref={ref} value="原文" {...props}/>),editor=EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
 const next="恢复内容\r\n\r\n😀 needle";rerender(<MarkdownEditor ref={ref} value={next} {...props}/>);
 expect(editor.state.doc.toString()).toBe(next.replaceAll("\r\n","\n"));expect(change).not.toHaveBeenCalled();
 act(()=>{expect(ref.current!.revealMatch(highlight(next,"needle"))).toBe(true);});expect(change).not.toHaveBeenCalled();expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)).toBe(editor);
});
it.each(["search","heading","anchor"] as const)("迟到 %s RAF 在滚动前校验导航身份",kind=>{
 let frame!:FrameRequestCallback,allowed=true;vi.spyOn(window,"requestAnimationFrame").mockImplementation(callback=>{frame=callback;return 1;});vi.spyOn(window,"cancelAnimationFrame").mockImplementation(()=>{});
 const source="# 标题\n\n命中",handled=vi.fn();render(<MarkdownPreview note="笔记.md" content={source} onError={()=>{}} {...(kind==="search"?{searchHighlight:highlight(source,"命中"),isSearchCurrent:()=>allowed,onSearchLocated:handled}:kind==="heading"?{headingJump:{from:0,serial:1,content:source},isHeadingCurrent:()=>allowed,onHeadingHandled:handled}:{anchor:"标题",isAnchorCurrent:()=>allowed,onAnchorHandled:handled})}/>);
 allowed=false;act(()=>frame(0));expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();expect(handled).not.toHaveBeenCalled();
});
it("编辑器范围导航不修改正文/历史，手动选区、组字和清理都移除临时标记",async()=>{
 const value="标题\r\n\r\n😀 前缀 needle\r\n",ref=createRef<EditorHandle>(),change=vi.fn(),clear=vi.fn();
 const {container,rerender}=render(<MarkdownEditor ref={ref} notePath="笔记.md" value={value} disabled={false} live onChange={change} onSave={()=>{}} onSaveAs={()=>{}} onImport={()=>{}} onSearchClear={clear}/>);
 const editor=EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!,match=highlight(value,"needle");
 act(()=>{expect(ref.current!.revealMatch(match)).toBe(true);});
 expect(editor.state.sliceDoc(editor.state.selection.main.from,editor.state.selection.main.to)).toBe("needle");expect(container.querySelector(".cm-vault-search-hit")?.textContent).toBe("needle");expect(change).not.toHaveBeenCalled();
 act(()=>editor.dispatch({selection:{anchor:1}}));expect(clear).toHaveBeenCalledWith(1);expect(container.querySelector(".cm-vault-search-hit")).toBeNull();
 act(()=>{ref.current!.revealMatch({...match,serial:2});});fireEvent.compositionStart(editor.contentDOM);expect(editor.state.field(editorSearchMark)).toBeNull();expect(clear).toHaveBeenCalledWith(2);fireEvent.compositionEnd(editor.contentDOM);
 await waitFor(()=>expect(container.querySelector(".cm-vault-search-hit")).toBeNull());
 rerender(<MarkdownEditor ref={ref} notePath="笔记.md" value={value} disabled={false} live onChange={change} onSave={()=>{}} onSaveAs={()=>{}} onImport={()=>{}}/>);
 expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)).toBe(editor);expect(change).not.toHaveBeenCalled();
});
