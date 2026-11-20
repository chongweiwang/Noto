// @vitest-environment jsdom
import "../test/codemirror-dom";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {EditorView} from "@codemirror/view";
import {MarkdownEditor} from "./markdown-editor";
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from "../lib/workspace-runtime";
import type {WorkspaceApi} from "../lib/vault-api";
import {emptyDrawing,serializeDrawing} from "../lib/drawing-document";
vi.mock("../lib/mermaid",()=>({renderMermaid:async()=>"<svg/>"}));
afterEach(cleanup);

it.each(["desktop","web"] as const)("%s 实时编辑的嵌入不修改正文，键盘编辑语法保留原 EditorView",async kind=>{
 const read=vi.fn(async(path:string)=>({path,content:"# 标题\n\n保存的正文",version:"1"}));
 const runtime:WorkspaceRuntime={kind,api:{read} as unknown as WorkspaceApi};
 const changed=vi.fn(),source="开头\n\n![[目标#标题]]\n\n尾部";
 const {container}=render(<WorkspaceRuntimeContext.Provider value={runtime}><MarkdownEditor value={source} notePath="宿主.md" disabled={false} live wikiPaths={["宿主.md","目标.md"]} onChange={changed} onSave={()=>{}} onSaveAs={()=>{}} onImport={()=>{}}/></WorkspaceRuntimeContext.Provider>);
 const view=EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
 await screen.findByText("保存的正文");expect(view.state.doc.toString()).toBe(source);expect(changed).not.toHaveBeenCalled();
 fireEvent.keyDown(screen.getByRole("button",{name:"编辑嵌入语法"}),{key:"Enter"});
 await waitFor(()=>expect(view.state.selection.main.from).toBe(source.indexOf("![[")));
 expect(view.state.doc.toString()).toBe(source);expect(changed).not.toHaveBeenCalled();
 act(()=>view.dispatch({changes:{from:source.length,insert:"继续"},userEvent:"input.type"}));
 expect(view.state.doc.toString()).toBe(source+"继续");
});

it.each(["desktop","web"] as const)("%s 实时编辑展示已保存白板并打开原文件",async kind=>{
 const read=vi.fn(async(path:string)=>({path,content:serializeDrawing(emptyDrawing()),version:"1"})),open=vi.fn(),changed=vi.fn();
 const runtime:WorkspaceRuntime={kind,api:{read} as unknown as WorkspaceApi},source="标题\n\n![[图/a.drawing]]\n\n正文";
 const {container}=render(<WorkspaceRuntimeContext.Provider value={runtime}><MarkdownEditor value={source} notePath="宿主.md" disabled={false} live drawingPaths={["图/a.drawing"]} onOpenNote={open} onChange={changed} onSave={()=>{}} onSaveAs={()=>{}} onImport={()=>{}}/></WorkspaceRuntimeContext.Provider>);
 const view=EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!,preview=await screen.findByRole("button",{name:"打开白板 图/a.drawing"});
 expect(preview.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
 fireEvent.click(preview);expect(open).toHaveBeenCalledWith("图/a.drawing");expect(view.state.doc.toString()).toBe(source);expect(changed).not.toHaveBeenCalled();
});
