"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState, Compartment, Transaction, type Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, selectAll } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, startCompletion } from "@codemirror/autocomplete";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { editorTheme, liveMarkdownPlugin, markdownRenderTheme, mdHighlightStyle, notePathFacet } from "./noteriv-markdown";
import { replaceDocument } from "../lib/replace-document";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { assetApiFacet } from "./noteriv-markdown/context";
import FormattingToolbar, { type FormatAction } from "./noteriv-formatting-toolbar";
import { richMarkdownField } from "./noteriv-markdown/rich-rendering";
import { openWikiAtCursor, wikiCompletion, wikiConfigFacet, wikiLinkPlugin } from "./noteriv-markdown/wikilinks";
import type { EditorViewState } from "../lib/workspace-state";
import type {WikiServices,WikiOpen} from "../lib/wiki-ui";
import { attachmentMarkdown, readAttachment } from "../lib/attachment-input";
import { codeCopyPlugin } from "./code-copy";
import {editorSearchMark,searchMarkEffect} from "./search-decoration";
import {normalizeSearchText,rawSearchOffset,type SearchHighlight} from "../lib/note-search";
import {liveNoteEmbeds} from "./live-note-embeds";
import { copyText } from "../lib/ui-actions";
import type { EditorPosition } from "../lib/editor-position";
import type { EditorAnalysisMessage, DocumentInfo } from "../lib/editor-markdown-index";
import { analysisReady, documentInfos, setEditorIndex } from "./noteriv-markdown/indexed-document";

type EditorRange = { doc: Text; from: number; to: number };
type EditorMenu = { range: EditorRange; x: number; y: number; keyboard: boolean };
export interface EditorHandle { focus: () => void; insert: (text: string) => void; restoreSnapshot?: (content:string,expected:string)=>boolean; reveal: (from: number, expected?:string) => boolean; revealMatch:(highlight:SearchHighlight)=>boolean; capture: () => EditorViewState | undefined; measure: () => void; flushImports: () => Promise<void>; hasPendingImports: () => boolean }

// The CodeMirror setup and live rendering are adapted from Noteriv's Editor and SourceEditor.
export const MarkdownEditor = forwardRef<EditorHandle, {
  value: string; notePath: string; disabled: boolean; live: boolean; large?: boolean; active?: boolean; focused?: boolean; isFocusCurrent?: () => boolean;
  onChange: (value: string) => void; onSave: () => void; onSaveAs: () => void; onImport: () => void;
  wikiPaths?: string[]; drawingPaths?:string[]; onOpenNote?:(path:string)=>void; onWikiOpen?: WikiOpen; wikiServices?:WikiServices; onReady?:()=>void; searchHighlight?:SearchHighlight; onSearchClear?:(serial:number)=>void;embedScope?:string;embedRevision?:number;
  onPositionChange?: (position: EditorPosition) => void;
  onDocumentInfo?: (source: string, info: DocumentInfo) => void;
  initialState?: EditorViewState; onViewStateChange?: (state: EditorViewState) => void;
  onError?: (error: string) => void; onImported?: (path: string) => void; onImportStateChange?: (pending: boolean) => void;
}>(function MarkdownEditor({ value, notePath, disabled, live, large = false, active = true, focused = active, isFocusCurrent, onChange, onSave, onSaveAs, onImport, wikiPaths = [],drawingPaths=[],onOpenNote, onWikiOpen, wikiServices, onReady, searchHighlight, onSearchClear, onPositionChange, onDocumentInfo, initialState, onViewStateChange, onError, onImported, onImportStateChange,embedScope="",embedRevision=0 }, ref) {
  const runtime = useWorkspaceRuntime(),{ api }=runtime;
  const [menu, setMenu] = useState<EditorMenu | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(null); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => { if (!active) setMenu(null); }, [active]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const synchronizing=useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onSaveAsRef = useRef(onSaveAs);
  const onImportRef = useRef(onImport);
  const onPositionRef = useRef(onPositionChange);
  const onDocumentInfoRef = useRef(onDocumentInfo); onDocumentInfoRef.current = onDocumentInfo;
  const onViewStateRef = useRef(onViewStateChange), initial = useRef(initialState), restoreScroll = useRef(!!initialState);
  const activeRef = useRef(active); activeRef.current = active;
  const largeRef = useRef(large); largeRef.current = large;
  const focusedRef = useRef(focused); focusedRef.current = focused;
  const focusCurrentRef = useRef(isFocusCurrent); focusCurrentRef.current = isFocusCurrent;
  const savedScroll = useRef({ scrollTop: initialState?.scrollTop ?? 0, scrollLeft: initialState?.scrollLeft ?? 0 });
  const activated = useRef(false);
  const imports = useRef(new Set<Promise<void>>()), importPositions = useRef(new Map<object, number>());
  const importCallbacks = useRef({ onError, onImported, onImportStateChange }); importCallbacks.current = { onError, onImported, onImportStateChange };
  const editable = useRef(new Compartment());
  const presentation = useRef(new Compartment());
  const historyConfig = useRef(new Compartment());
  const wikiConfig = useRef(new Compartment());
  const onWikiOpenRef = useRef(onWikiOpen),openNoteRef=useRef(onOpenNote),noteRef=useRef(notePath),readyRef=useRef(onReady),navigationScroll=useRef(false);openNoteRef.current=onOpenNote;
  noteRef.current=notePath;readyRef.current=onReady;
  const searchClearRef=useRef(onSearchClear);searchClearRef.current=onSearchClear;
  const handleWiki = useRef((target: string) => onWikiOpenRef.current?.(target,noteRef.current));
  onWikiOpenRef.current = onWikiOpen;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onSaveAsRef.current = onSaveAs;
  onImportRef.current = onImport;
  onPositionRef.current = onPositionChange;
  onViewStateRef.current = onViewStateChange;

  function capture(): EditorViewState | undefined {
    const editor = view.current;
    if (!editor) return;
    const { anchor, head } = editor.state.selection.main;
    if (activeRef.current && !restoreScroll.current) savedScroll.current = { scrollTop: editor.scrollDOM.scrollTop, scrollLeft: editor.scrollDOM.scrollLeft };
    return { anchor, head, ...savedScroll.current };
  }
  function rememberView() { const state = capture(); if (state) onViewStateRef.current?.(state); }
  function importFiles(files: File[], position: number) {
    const target = view.current;
    if (!target || target.state.readOnly || !files.length) return;
    if (!api.importAttachmentData) { importCallbacks.current.onError?.("当前环境不支持粘贴或拖入附件，请使用导入附件。"); return; }
    const token = {}; importPositions.current.set(token, position);
    const flight = (async () => {
      for (const file of files) {
        const bytes = await readAttachment(file);
        const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
        const name = file.name || `图片-${Date.now()}.${extension}`;
        const relative = await api.importAttachmentData!(notePath, name, bytes);
        if (view.current !== target) { importCallbacks.current.onError?.(`附件已保存为 ${relative}，原笔记已关闭，请从文件树插入链接。`); return; }
        const at = Math.min(importPositions.current.get(token) ?? target.state.doc.length, target.state.doc.length);
        const text = `${attachmentMarkdown(relative)}\n`;
        target.dispatch({ changes: { from: at, insert: text }, annotations: isolateHistory.of("full") });
        importPositions.current.set(token, at + text.length);
        importCallbacks.current.onImported?.(relative);
      }
    })().catch((cause) => importCallbacks.current.onError?.(`导入附件失败：${cause instanceof Error ? cause.message : String(cause)}`));
    imports.current.add(flight); importCallbacks.current.onImportStateChange?.(true);
    void flight.finally(() => { imports.current.delete(flight); importPositions.current.delete(token); importCallbacks.current.onImportStateChange?.(imports.current.size > 0); });
  }

  function presentationExtensions(showLive: boolean) {
    const normal = large ? [] : [codeCopyPlugin, EditorView.lineWrapping, wikiCompletion];
    return showLive ? [...normal, editorTheme, markdownRenderTheme, richMarkdownField, liveMarkdownPlugin, wikiLinkPlugin,liveNoteEmbeds({runtime,path:notePath,paths:wikiPaths,drawingPaths,scope:embedScope,revision:embedRevision,active,open:(target,source,chosen)=>onWikiOpenRef.current?.(target,source,chosen),openDocument:path=>openNoteRef.current?.(path),services:wikiServices,error:value=>importCallbacks.current.onError?.(value)})] : [
      ...normal,
      lineNumbers(), highlightActiveLine(),
      EditorView.theme({
        "&": { height: "100%", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: "var(--editor-font-size, 15px)" },
        ".cm-scroller": { fontFamily: "var(--editor-font, 'JetBrains Mono', 'Fira Code', monospace)", lineHeight: "var(--editor-line-height, 1.7)", padding: "1rem 1.5rem", overflow: "auto" },
        ".cm-content": { maxWidth: "var(--content-width, 880px)", margin: "0 auto", flexGrow: "1" },
        ".cm-gutters": { background: "transparent", border: "none", color: "var(--text-muted)" },
        ".cm-cursor": { borderLeftColor: "var(--accent)" },
      }),
    ];
  }

  useEffect(() => {
    if (!host.current) return;
    let positionFrame = 0;
    function reportPosition(editor: EditorView) {
      const from = editor.state.selection.main.head, line = editor.state.doc.lineAt(from);
      const prefix = editor.state.sliceDoc(line.from, from);
      let column = prefix.length + 1;
      if (/[\uD800-\uDBFF]/.test(prefix)) {
        for (const _pair of prefix.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) column--;
      }
      onPositionRef.current?.({ from, line: line.number, column });
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        selection: initial.current ? { anchor: Math.min(value.length, initial.current.anchor), head: Math.min(value.length, initial.current.head) } : undefined,
        extensions: [
          drawSelection(), closeBrackets(), editorSearchMark, historyConfig.current.of(history()), notePathFacet.of(notePath), assetApiFacet.of(api),
          EditorView.domEventHandlers({
            compositionstart(_event,editor){if(editor.state.field(editorSearchMark))editor.dispatch({effects:searchMarkEffect.of(null)});return false;},
            paste(event, editor) {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (!files.length || editor.state.readOnly || editor.compositionStarted) return false;
              event.preventDefault(); importFiles(files, editor.state.selection.main.from); return true;
            },
            dragover(event, editor) { if (!editor.state.readOnly && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; return true; } return false; },
            drop(event, editor) {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (!files.length || editor.state.readOnly) return false;
              event.preventDefault(); importFiles(files, editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.from); return true;
            },
          }),
          wikiConfig.current.of(wikiConfigFacet.of({ paths: wikiPaths, notePath, services:wikiServices, active:()=>activeRef.current, onOpen: handleWiki.current })),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(mdHighlightStyle), search({ top: true }),
          presentation.current.of(presentationExtensions(live)),
          editable.current.of([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]),
          keymap.of([{ key: "Mod-Shift-s", run: () => { onSaveAsRef.current(); return true; } }, { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
            { key: "Mod-b", run: (editor) => { if (editor.compositionStarted) return false; format("toggleBold"); return true; } },
            { key: "Mod-i", run: (editor) => { if (editor.compositionStarted) return false; format("toggleItalic"); return true; } },
            { key: "Mod-k", run: (editor) => { if (editor.compositionStarted) return false; format("insertLink"); return true; } },
            { key: "Mod-Enter", run: (editor) => !editor.compositionStarted && openWikiAtCursor(editor) },
            ...searchKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            const before=update.startState.field(editorSearchMark),after=update.state.field(editorSearchMark);
            if(before&&!after)searchClearRef.current?.(before.serial);
            if (update.docChanged) for (const [token, position] of importPositions.current) importPositions.current.set(token, update.changes.mapPos(position, -1));
            if (update.docChanged&&!synchronizing.current) onChangeRef.current(update.state.doc.toString());
            if ((update.docChanged || update.selectionSet) && !positionFrame) {
              positionFrame = requestAnimationFrame(() => {
                positionFrame = 0;
                reportPosition(update.view);
                rememberView();
              });
            }
            if (!largeRef.current && update.docChanged && !update.view.compositionStarted && update.transactions.some((transaction) => transaction.isUserEvent("input.type"))) {
              const pos = update.state.selection.main.from;
              if (update.state.sliceDoc(Math.max(0, pos - 2), pos) === "[[") queueMicrotask(() => { if (view.current === update.view) startCompletion(update.view); });
            }
          }),
        ],
      }),
    });
    view.current = editor;
    readyRef.current?.();
    editor.scrollDOM.addEventListener("scroll", rememberView);
    const composed=()=>queueMicrotask(()=>readyRef.current?.());editor.contentDOM.addEventListener("compositionend",composed);
    reportPosition(editor);
    return () => { cancelAnimationFrame(positionFrame); rememberView(); editor.scrollDOM.removeEventListener("scroll", rememberView); editor.contentDOM.removeEventListener("compositionend",composed); editor.destroy(); view.current = null; };
    // The view is mounted once; changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== normalizeSearchText(value)) {
      // A reloaded file is not an undoable user edit. Noteriv resets history here
      // to prevent Undo from replacing an externally updated file with stale text.
      synchronizing.current=true;
      try{replaceDocument(editor, historyConfig.current, value);}finally{synchronizing.current=false;}
      readyRef.current?.();
    }
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]) }); }, [disabled]);
  useEffect(() => { view.current?.dispatch({ effects: presentation.current.reconfigure(presentationExtensions(live)) }); }, [live,large,active,notePath,wikiPaths.join("\0"),drawingPaths.join("\0"),embedScope,embedRevision,runtime,wikiServices]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !large || !active) return;
    const doc = editor.state.doc;
    const cached = documentInfos.get(doc);
    if (cached) {
      if (focused) onDocumentInfoRef.current?.(value, cached);
      return;
    }
    let worker: Worker | undefined;
    const failed = () => importCallbacks.current.onError?.("这篇笔记的后台分析未完成，原文仍可编辑。");
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL("../lib/editor-markdown.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }: MessageEvent<EditorAnalysisMessage>) => {
          if (view.current !== editor || editor.state.doc !== doc) return;
          if (data.type === "index") {
            setEditorIndex(doc, data.index);
            editor.dispatch({ effects: analysisReady.of(null) });
          } else {
            worker?.terminate();
            if (data.type === "info") {
              documentInfos.set(doc, data.info);
              if (focused) onDocumentInfoRef.current?.(value, data.info);
            } else failed();
          }
        };
        worker.onerror = () => { worker?.terminate(); failed(); };
        worker.postMessage(doc.toString());
      } catch { failed(); }
    }, 220);
    return () => { clearTimeout(timer); worker?.terminate(); };
  }, [active, focused, large, value]);
  useEffect(() => {
    if (!active || !focused) return;
    const frame = requestAnimationFrame(() => {
      const editor = view.current;
      if (!editor || !activeRef.current || !focusedRef.current || focusCurrentRef.current?.() === false) return;
      const restore = !navigationScroll.current && (!!initial.current || activated.current || savedScroll.current.scrollTop > 0 || savedScroll.current.scrollLeft > 0);
      navigationScroll.current=false;
      restoreScroll.current = restore;
      editor.focus();
      editor.requestMeasure({ read: () => null, write: () => {
        if (!activeRef.current) return;
        if (restore) { editor.scrollDOM.scrollTop = savedScroll.current.scrollTop; editor.scrollDOM.scrollLeft = savedScroll.current.scrollLeft; }
        restoreScroll.current = false; activated.current = true;
        rememberView();
      } });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focused]);
  const wikiPathsKey = wikiPaths.join("\0");
  useEffect(() => { view.current?.dispatch({ effects: wikiConfig.current.reconfigure(wikiConfigFacet.of({ paths: wikiPaths, notePath, services:wikiServices, active:()=>activeRef.current, onOpen: handleWiki.current })) }); }, [wikiPathsKey,notePath,wikiServices]);

  useEffect(()=>{
    const editor=view.current;if(!editor)return;
    const mark=active&&searchHighlight&&normalizeSearchText(searchHighlight.content)===editor.state.doc.toString()?{
      from:rawSearchOffset(searchHighlight.content,searchHighlight.from),to:rawSearchOffset(searchHighlight.content,searchHighlight.to),serial:searchHighlight.serial
    }:null;
    const current=editor.state.field(editorSearchMark);
    if(current?.serial===mark?.serial&&current?.from===mark?.from&&current?.to===mark?.to)return;
    editor.dispatch({effects:searchMarkEffect.of(mark)});
  },[active,searchHighlight,value]);

  function surround(before: string, after = before, toggle = false) {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const { from, to } = editor.state.selection.main;
    const selected = editor.state.sliceDoc(from, to);
    if (toggle && selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
      const text = selected.slice(before.length, selected.length - after.length);
      editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length }, annotations: isolateHistory.of("full") });
    } else if (toggle && from >= before.length && editor.state.sliceDoc(from - before.length, from) === before && editor.state.sliceDoc(to, to + after.length) === after) {
      editor.dispatch({ changes: [{ from: from - before.length, to: from }, { from: to, to: to + after.length }], selection: { anchor: from - before.length, head: to - before.length }, annotations: isolateHistory.of("full") });
    } else {
      editor.dispatch({ changes: { from, to, insert: `${before}${selected}${after}` }, selection: { anchor: from + before.length, head: from + before.length + selected.length }, annotations: isolateHistory.of("full") });
    }
    editor.focus();
  }
  function insert(text: string) {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const { from, to } = editor.state.selection.main;
    editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, annotations: isolateHistory.of("full") });
    editor.focus();
  }
  function toggleLinePrefix(prefix: string) {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const selection = editor.state.selection.main;
    const start = editor.state.doc.lineAt(selection.from).number;
    const end = editor.state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to).number;
    const lines = Array.from({ length: end - start + 1 }, (_, index) => editor.state.doc.line(start + index));
    const remove = lines.every((line) => line.text.startsWith(prefix));
    const changes = editor.state.changes(lines.map((line) => remove ? { from: line.from, to: line.from + prefix.length } : { from: line.from, insert: prefix }));
    editor.dispatch({ changes, selection: { anchor: changes.mapPos(selection.anchor, 1), head: changes.mapPos(selection.head, 1) }, annotations: isolateHistory.of("full") });
    editor.focus();
  }
  function format(action: FormatAction) {
    if (!view.current || view.current.state.readOnly || view.current.compositionStarted) return;
    switch (action) {
      case "heading": toggleLinePrefix("# "); break;
      case "toggleBold": surround("**", "**", true); break;
      case "toggleItalic": surround("*", "*", true); break;
      case "toggleStrikethrough": surround("~~", "~~", true); break;
      case "toggleCode": surround("`", "`", true); break;
      case "insertLink": surround("[", "](https://)"); break;
      case "insertImage": onImportRef.current(); break;
      case "insertBlockquote": toggleLinePrefix("> "); break;
      case "insertCodeBlock": surround("```\n", "\n```"); break;
      case "insertList": toggleLinePrefix("- "); break;
      case "insertTaskList": toggleLinePrefix("- [ ] "); break;
      case "insertTable": insert("\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n"); break;
      case "insertHorizontalRule": insert("\n---\n"); break;
    }
  }

  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus(), insert, capture, restoreSnapshot:(content,expected)=>{
    const editor=view.current;
    if(!editor||editor.compositionStarted||editor.state.doc.toString()!==expected)return false;
    editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:content},selection:{anchor:0},annotations:isolateHistory.of("full"),userEvent:"input.restore"});
    return true;
  }, flushImports: async () => { await Promise.all([...imports.current]); }, hasPendingImports: () => imports.current.size > 0, measure: () => view.current?.requestMeasure(), reveal: (from,expected) => {
    const editor = view.current;
    if (!editor||editor.compositionStarted||expected!==undefined&&editor.state.doc.toString()!==normalizeSearchText(expected)) return false;
    navigationScroll.current=true;
    const position = Math.max(0, Math.min(editor.state.doc.length, expected===undefined?from:rawSearchOffset(expected,from)));
    editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start", yMargin: 16 }) });
    editor.focus();return true;
  },revealMatch:(highlight)=>{
    const editor=view.current;
    if(!editor||editor.compositionStarted||normalizeSearchText(highlight.content)!==editor.state.doc.toString())return false;
    const from=rawSearchOffset(highlight.content,highlight.from),to=rawSearchOffset(highlight.content,highlight.to);
    if(from<0||to>editor.state.doc.length||from>=to)return false;
    navigationScroll.current=true;
    editor.dispatch({selection:{anchor:from,head:to},effects:[searchMarkEffect.of({from,to,serial:highlight.serial}),EditorView.scrollIntoView(from,{y:"center"})],annotations:Transaction.addToHistory.of(false)});
    editor.focus();return true;
  } }), []);

  function currentEditor(range: EditorRange, editing = false) {
    const editor = view.current;
    if (!activeRef.current || !editor || editor.state.doc !== range.doc || editor.compositionStarted ||
      editing && (editor.state.readOnly || focusCurrentRef.current?.() === false)) return;
    return editor;
  }

  async function copySelection(range: EditorRange, cut = false) {
    const editor = currentEditor(range, cut);
    if (!editor || range.from === range.to) return;
    editor.focus();
    const selection = editor.state.selection.main;
    // The native copy action also works on plain HTTP when the editor has focus.
    let native = false;
    try { if (selection.from === range.from && selection.to === range.to) native = document.execCommand?.("copy") ?? false; }
    catch { /* Fall back to the shared clipboard action. */ }
    const copied = native || await copyText(editor.state.sliceDoc(range.from, range.to));
    if (cut && copied && currentEditor(range, true)) {
      editor.dispatch({ changes: { from: range.from, to: range.to }, selection: { anchor: range.from }, userEvent: "delete.cut", scrollIntoView: true });
    }
  }

  async function pasteSelection(range: EditorRange) {
    const editor = currentEditor(range, true);
    if (!editor) return;
    try {
      if (!navigator.clipboard?.readText) throw new Error("剪贴板不可用");
      const text = await navigator.clipboard.readText();
      if (!text || !currentEditor(range, true)) return;
      const insert = editor.state.toText(text);
      editor.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, userEvent: "input.paste", scrollIntoView: true });
      editor.focus();
    } catch {
      if (!currentEditor(range, true)) return;
      editor.dispatch({ selection: { anchor: range.from, head: range.to } });
      editor.focus();
      onError?.("无法直接读取剪贴板，请按 Ctrl+V 粘贴。");
    }
  }

  return <div className="editor-shell">
    <FormattingToolbar onAction={format} disabled={disabled} />
    <div className="codemirror-host" ref={host} aria-label="Markdown 编辑器" onContextMenu={event => {
      const editor = view.current, target = event.target;
      if (!editor || !active || editor.compositionStarted || !(target instanceof Element) || !editor.scrollDOM.contains(target)) return;
      event.preventDefault();
      const { from, to } = editor.state.selection.main;
      const keyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
      const line = target.closest(".cm-line");
      const clicked = keyboard ? from : line && editor.contentDOM.contains(line)
        ? editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.posAtDOM(line) : null;
      const range = { doc: editor.state.doc, from: from === to ? clicked ?? from : from, to: from === to ? clicked ?? to : to };
      const location = keyboard ? editor.coordsAtPos(from) : null;
      setMenu({ range, x: location?.left ?? event.clientX, y: location?.bottom ?? event.clientY, keyboard });
    }} />
    {menu && <div role="menu" aria-label="编辑操作" className="file-menu editor-context-menu" ref={element => {
      menuElement.current = element;
      if (!element) return;
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
      if (menu.keyboard && !element.contains(document.activeElement)) element.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    }} onMouseDown={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); setMenu(null); view.current?.focus(); }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + buttons.length + (event.key === "ArrowDown" ? 1 : -1)) % buttons.length]?.focus();
      }
    }}>
      <button type="button" role="menuitem" disabled={disabled || menu.range.from === menu.range.to} onClick={() => { setMenu(null); void copySelection(menu.range, true); }}>剪切</button>
      <button type="button" role="menuitem" disabled={menu.range.from === menu.range.to} onClick={() => { setMenu(null); void copySelection(menu.range); }}>复制</button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenu(null); void pasteSelection(menu.range); }}>粘贴</button>
      <button type="button" role="menuitem" onClick={() => { setMenu(null); const editor = currentEditor(menu.range); if (editor) { selectAll(editor); editor.focus(); } }}>全选</button>
    </div>}
  </div>;
});
