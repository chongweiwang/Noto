"use client";

import {isCanvas,isDrawing,isStructuredDocument,isDocument,isMarkdown,documentPaths,documentName} from "../lib/document-kind";
import {formatDrawingEmbed} from "../lib/note-embed";
import {saveFeedback} from "../lib/save-feedback";
import {resolveSearchHit,createSearchHit,type SearchContext,type SearchChoice,type SearchHighlight,type SearchLocal} from "../lib/note-search";
import {headingIndex,findHeading,type HeadingEntry} from "../lib/heading-index";
import {resolveWikiTarget,headingProblem,formatWikiHeading,formatWikiBlock} from "../lib/wiki-target";
import type {WikiServices} from "../lib/wiki-ui";
import {copyText as copyWikiText} from "../lib/ui-actions";
import {blockIndex,findBlock,type BlockIndex,type BlockKind} from "../lib/wiki-block";
import {emptyCanvas,serializeCanvas,parseCanvas} from "../lib/canvas-document";
import {KnowledgeCanvas,type CanvasHandle} from "./knowledge-canvas";
import {DrawingWhiteboard,type DrawingHandle} from "./drawing-whiteboard";
import {emptyDrawing,parseDrawing,serializeDrawing} from "../lib/drawing-document";
import type {DrawingViewState} from "../lib/workspace-state";
import type {CanvasViewState} from "../lib/workspace-state";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent } from "react";
import { normalizeNotePanes, remapNotePanes, type NotePanes } from "../lib/note-panes";
import type { Draft, Entry, HistorySnapshot, Note, TrashItem, VaultStatus } from "../lib/vault-api";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { isTransient, WorkspaceError } from "../lib/api-error";
import { MarkdownEditor, type EditorHandle } from "./markdown-editor";
import { createEditorPositions, type EditorPositions } from "../lib/editor-position";
import type { DocumentInfo } from "../lib/editor-markdown-index";
import { MarkdownPreview } from "./markdown-preview";
import { BacklinksPanel, CalendarPanel, SearchPanel, useKnowledgeSnapshot } from "./knowledge-sidebar";
import { DashboardPanel } from "./dashboard-panel";
import { NoteHeatmap } from "./note-heatmap";
import { WidgetDrawer } from "./widget-drawer";
import { TagPanel } from "./tag-panel";
import { notePaths, wikiTargetForPath, type RelationIndex } from "../lib/knowledge";
import { useVaultAnalysis } from "../lib/vault-analysis-client";
import type { VaultAnswer } from "../lib/vault-analysis";
import { dailyPath, localDate } from "../lib/calendar";
import { appendExistingTask, isTaskCategoryDocument, parseTaskDocument, removeTask, taskCategoryMarker, taskFolder, taskMoveIssue, type TaskStatus } from "../lib/tasks";
import { appendManagedTask, changeManagedTask, placeTask, taskWritable } from "../lib/task-board";
import { TaskSidebar, TaskWorkspace, categoryName, type TaskAction, type TaskFocus, type TaskItemView } from "./task-workspace";
import { WorkspaceTabs, panelId, tasksTabId, transferredTab, workspaceTabType } from "./workspace-tabs";
import { WorkspaceIcon } from "./workspace-icon";
import { VaultSwitcher } from "./vault-switcher";
import { themeVariables } from "../lib/themes";
import { toggleThemePreference } from "../lib/workspace-state";
import { defaultTaskGroup, encodePath, ensureDirectory, findEntry, isTaskOrJournalRoot, pathName, relativePath, taskFiles, taskGroupOf, taskGroups } from "../lib/vault-structure";
import { organizeLegacyVault, RelocationError, relocateNotes, remapPath, rewriteDocumentLinks } from "../lib/relocate-notes";
import { documentInfo, documentSize, isLargeMarkdown, type DocumentHeading } from "../lib/document-info";
import { OutlinePanel } from "./outline-panel";
import { FileTree, FolderPicker } from "./file-tree";
import { ResizeHandle } from "./resize-handle";
import { ExportDialog } from "./export-dialog";
import { BatchExportPicker } from "./batch-export-picker";
import { SlideViewer } from "./slide-viewer";
import type { Replacement } from "./search-panel";
import { FileHistoryDialog } from "./file-history-dialog";
import { WebDavDialog } from "./webdav-dialog";
import type {WebDavConfig,SyncResolution} from "../lib/vault-api";
import type { ExportSnapshot } from "../lib/note-export";
import { SettingsDialog } from "./settings-dialog";
import { QuickPalette, type PaletteItem } from "./quick-palette";
import { ImageViewer } from "./image-viewer";
import { PdfViewer } from "./pdf-viewer";
import type { GraphicFormat } from "../lib/graphic-export";
import { KnowledgeGraphView } from "./knowledge-graph-view";
import type { KnowledgeGraph } from "../lib/knowledge-graph";
import { imagePreviewEvent, isPdfPath, manualCopyEvent, pdfPreviewEvent, previewPdf } from "../lib/ui-actions";
import { attachmentMarkdown } from "../lib/attachment-input";
import { graphTabId, isFileTab, defaultGraphSettings, type GraphSettings, defaultTaskViewSettings, type TaskViewSettings, defaultPreferences, emptyWorkspace, fontFamilies, normalizePreferences, normalizeWorkspace, orderTabs, preferencesKey, reorderTabs, workspaceStorageKey, type AppPreferences, type EditorViewState, type ViewMode, type WorkspaceState } from "../lib/workspace-state";

type Session = { note: Note; content: string; conflict: string | null };
const emptyRelations: RelationIndex = { paths: [], readable: new Set(), references: [] };
const emptyGraph: KnowledgeGraph = { nodes: [], edges: [] };
type RelationAnswer = Extract<VaultAnswer, { kind: "relations" }>;
function initialNoteMode(content: string, requested: ViewMode): ViewMode {
  return (requested === "preview" || requested === "split") && isLargeMarkdown(content) ? "source" : requested;
}

function CursorPosition({ positions, path }: { positions: EditorPositions; path: string }) {
  const position = useSyncExternalStore(positions.subscribe, () => positions.get(path), () => undefined);
  return <span>行 {position?.line ?? 1}，列 {position?.column ?? 1}</span>;
}
type Recovery = { draft: Draft; disk: Note | null };
type Dialog = { title: string; description?: string; value?: string; choices?: { value: string; label: string }[]; resolve: (value: string | null) => void };
type SidebarView = WorkspaceState["sidebarView"];
type Widget = "heatmap" | "dashboard";
const widgetTitles: Record<Widget, string> = { heatmap: "笔记热力图", dashboard: "仪表盘" };
type Workspace = "notes" | "tasks" | "graph";
const themeKey = "noto.theme";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const needsDraft = (session: Session) => session.content !== session.note.content || !!session.conflict;
const affected = (path: string, target: string) => path === target || path.startsWith(`${target}/`);
function taskCategoryBase(raw: string): string | null {
  const name = raw.trim().replace(/\.(?:md|markdown)$/i, "").trim();
  return !name || name.startsWith(".") || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? null : name;
}

export default function DesktopApp() {
  const runtime = useWorkspaceRuntime();
  const desktop = runtime.api;
  const web = runtime.kind === "web";
  const retryAfter = useRef(new Map<string, number>());
  const [trashItems, setTrashItems] = useState<TrashItem[] | null>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  const [vault, setVault] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState("");
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const sessionsRef = useRef<Record<string, Session>>({});
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const currentPathRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [recoveries, setRecoveries] = useState<Record<string, Recovery>>({});
  const recoveriesRef = useRef<Record<string, Recovery>>({});
  const recoveryRef = useRef<Recovery | null>(null);
  const session = currentPath ? sessions[currentPath] ?? null : null;
  const recovery = currentPath ? recoveries[currentPath] ?? null : null;
  const [tabs, setTabs] = useState<string[]>([]);
  const tabsRef = useRef<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const activeTabRef = useRef<string | null>(null);
  const [panes, setPanes] = useState<NotePanes>(() => normalizeNotePanes(null, [], null));
  const panesRef = useRef(panes);
  const draggedTab = useRef<string | null>(null);
  const dualPane = panes.right.length > 0;
  const leftTabs = tabs.filter(path => !panes.right.includes(path));
  const visibleTab = (path: string) => path === panes.leftActive || path === panes.rightActive;
  const lastNoteTab = useRef<string | null>(null);
  const graphContextNote = useRef<string | null>(null);
  const [taskPath, setTaskPath] = useState<string | null>(null);
  const taskPathRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [savingPaths, setSavingPaths] = useState<string[]>([]);
  const saveFlights = useRef(new Map<string, Promise<void>>());
  const structuredChecks=useRef(new Map<string,{source:string;issue:string}>());
  function documentSaveIssue(path:string,content:string){
    if(!isStructuredDocument(path))return "";
    const previous=structuredChecks.current.get(path);if(previous?.source===content)return previous.issue;
    let issue="";try{if(isDrawing(path))parseDrawing(content);else parseCanvas(content);}catch(cause){issue=message(cause);}
    structuredChecks.current.set(path,{source:content,issue});
    if(structuredChecks.current.size>100)structuredChecks.current.delete(structuredChecks.current.keys().next().value!);
    return issue;
  }
  const organizationFlight = useRef<Promise<unknown> | null>(null);
  const saving = !!currentPath && savingPaths.includes(currentPath);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [discardingDraft, setDiscardingDraft] = useState<string | null>(null);
  const draftErrors = useRef(new Map<string, string>());
  const [notice, setNotice] = useState("选择本地文件夹开始使用。");
  const [modes, setModes] = useState<Record<string, ViewMode>>({});
  const [previewed, setPreviewed] = useState<string[]>([]);
  const [preferences, setPreferences] = useState<AppPreferences>(defaultPreferences);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const largeNotes = useMemo(() => new Set(Object.values(sessions).filter(entry =>
    isMarkdown(entry.note.path) && isLargeMarkdown(entry.content)).map(entry => entry.note.path)), [sessions]);
  const largeNote = !!currentPath && largeNotes.has(currentPath);
  const mode = currentPath ? modes[currentPath] ?? preferences.defaultMode : preferences.defaultMode;
  const [largeInfo, setLargeInfo] = useState<{ path: string; content: string; info: DocumentInfo } | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<string | undefined>();
  const pendingAnchorNavigation=useRef<number|null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  const [workspace, setWorkspace] = useState<Workspace>("notes");
  const drawingActive=workspace==="notes"&&!!session&&isDrawing(session.note.path);
  const structuredActive=workspace==="notes"&&!!session&&isStructuredDocument(session.note.path);
  const [graphSettings, setGraphSettings] = useState<GraphSettings>({ ...defaultGraphSettings });
  const [taskCategory, setTaskCategory] = useState<string | null>(null);
  const [taskGroup, setTaskGroup] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [largeOutline, setLargeOutline] = useState<string | null>(null);
  const [positions] = useState(createEditorPositions);
  const [headingJumps, setHeadingJumps] = useState<Record<string, { from: number; serial: number; content?:string; navigation?:number;kind?:"block" }>>({});
  const jumpSerial = useRef(0);
  const [taskSettings, setTaskSettings] = useState<TaskViewSettings>({ ...defaultTaskViewSettings, scrolls: {} });
  const [taskFocus, setTaskFocus] = useState<TaskFocus | null>(null);
  const taskFocusSerial = useRef(0);
  const [knowledgeRevision, setKnowledgeRevision] = useState(0);
  const [wikiChoices, setWikiChoices] = useState<{ target: string; paths: string[]; source:string; sequence:number } | null>(null);
  const [fileMenu, setFileMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const theme = preferences.theme;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [widgetDrawer, setWidgetDrawer] = useState<Widget | null>(null);
  const [webdavOpen,setWebdavOpen]=useState(false),[webdavRunning,setWebdavRunning]=useState(false),webdavFlight=useRef(false);
  const [exportJob,setExportJob] = useState<{path:string;generation:number;snapshot:ExportSnapshot|null;error:string}|null>(null);
  const [batchPicker,setBatchPicker]=useState(false);
  const [batchExport,setBatchExport]=useState<{paths:string[];snapshots?:ExportSnapshot[];error:string}|null>(null);
  const [slides,setSlides]=useState<ExportSnapshot|null>(null);
  const batchSerial=useRef(0);
  const exportSerial=useRef(0);
  const [historyJob,setHistoryJob] = useState<{path:string;generation:number}|null>(null);
  const [historyRestoring,setHistoryRestoring] = useState(false), historyFlight=useRef(false);
  const [palette, setPalette] = useState<"files" | "commands" | null>(null);
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string } | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ path: string; page: number } | null>(null);
  const pdfCloseBlocked = useRef(false);
  const onPdfBlockClose = useCallback((blocked: boolean) => { pdfCloseBlocked.current = blocked; }, []);
  const [importingPaths, setImportingPaths] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(250), [outlineWidth, setOutlineWidth] = useState(220), [splitRatio, setSplitRatio] = useState(.5);
  const [narrow, setNarrow] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [managedFoldersExpanded, setManagedFoldersExpanded] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [movePicker, setMovePicker] = useState<{ source: string; resolve: (path: string | null) => void } | null>(null);
  const [pinned, setPinned] = useState<string[]>([]), pinnedRef = useRef<string[]>([]);
  const editorViews = useRef<Record<string, EditorViewState>>({}), previewScrolls = useRef<Record<string, number>>({});
  const workspaceKey = useRef<string | null>(null), workspaceReadyRef = useRef(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const metadataTimer = useRef<ReturnType<typeof setTimeout> | null>(null), metadataWarning = useRef(false);
  const workspaceSnapshot = useRef<WorkspaceState>(emptyWorkspace());
  const flushWorkspaceRef = useRef<() => void>(() => {});
  const mainPane = useRef<HTMLElement>(null);
  const sidebarVisible = !sidebarCollapsed && !(narrow && preferences.autoCollapseSidebar);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [mobileOutline, setMobileOutline] = useState(false);
  const showSidebar = sidebarVisible || narrow && mobileSidebar;
  const showOutline = !structuredActive && (largeNote ? largeOutline === currentPath : narrow ? mobileOutline : outlineOpen);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const editors = useRef(new Map<string, EditorHandle>());
  const canvases=useRef(new Map<string,CanvasHandle>());
  const canvasViews=useRef<Record<string,CanvasViewState>>({});
  const drawings=useRef(new Map<string,DrawingHandle>());
  const drawingViews=useRef<Record<string,DrawingViewState>>({});
  async function flushDocumentImports(path:string){await editors.current.get(path)?.flushImports();await canvases.current.get(path)?.flushImports();await drawings.current.get(path)?.flushImports();}

  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const saveRef = useRef<(path: string) => Promise<void>>(async () => {});
  const saveAsRef = useRef(saveAs); saveAsRef.current = saveAs;
  const refreshBusy = useRef(false);
  const recoveryRelocationRef = useRef(applyRelocation);
  recoveryRelocationRef.current = applyRelocation;
  const vaultGeneration = useRef(0);
  const canvasScope=runtime.kind+":"+(vault??"")+":"+vaultGeneration.current;
  const navigationSequence=useRef(0);
  const [wikiJump,setWikiJump]=useState<{sequence:number;generation:number;path:string;fragment:string}|null>(null);
  const [editorReady,setEditorReady]=useState(0);
  const markEditorReady=useCallback(()=>setEditorReady(value=>value+1),[]);
  const headingCache=useRef(new Map<string,{content:string;headings:HeadingEntry[]}>());
  const blockCache=useRef(new Map<string,{content:string;blocks:BlockIndex}>());
  const headingScope=useRef(canvasScope);
  if(headingScope.current!==canvasScope){headingScope.current=canvasScope;headingCache.current.clear();blockCache.current.clear();}
  const wikiRequestRef=useRef(requestWiki);wikiRequestRef.current=requestWiki;
  const searchContextRef=useRef<SearchContext|null>(null),searchFlight=useRef<number|null>(null);
  const [searchJump,setSearchJump]=useState<{choice:SearchChoice;sequence:number;generation:number;path:string}|null>(null);
  const [searchMark,setSearchMark]=useState<SearchHighlight|null>(null),searchMarkRef=useRef<SearchHighlight|null>(null);searchMarkRef.current=searchMark;
  const [searchStale,setSearchStale]=useState<{path:string;query:string}|null>(null),[searchLocal,setSearchLocal]=useState<SearchLocal|null>(null);
  const [searchPreviewStatus,setSearchPreviewStatus]=useState<"exact"|"source"|"missing"|null>(null);
  const requestSearchRef=useRef(requestSearch);requestSearchRef.current=requestSearch;
  const onSearchContext=useCallback((context:SearchContext|null)=>{
    if(searchContextRef.current===context)return;
    searchContextRef.current=context;cancelDocumentNavigation();
  },[]);
  const chooseSearch=useCallback((choice:SearchChoice)=>{void requestSearchRef.current(choice);},[]);
  const clearSearchHighlight=useCallback((serial:number)=>{
    if(searchMarkRef.current?.serial!==serial)return;
    searchMarkRef.current=null;setSearchMark(previous=>previous?.serial===serial?null:previous);setSearchPreviewStatus(null);
  },[]);


  const openNoteRef = useRef<(path: string, valid?:()=>boolean) => Promise<boolean>>(async () => false);
  workspaceSnapshot.current = { version: 1, tabs, active: activeTab, panes, pinned, sidebarCollapsed, outlineOpen, sidebarWidth, outlineWidth, splitRatio, collapsedFolders, managedFoldersExpanded, modes, editors: editorViews.current, previews: previewScrolls.current, selected, sidebarView, taskPath, taskCategory, taskGroup, graph: graphSettings, tasks: taskSettings,canvases:canvasViews.current,drawings:drawingViews.current };
  function storeWorkspace() {
    if (!workspaceReadyRef.current || !workspaceKey.current) return;
    if (metadataTimer.current) clearTimeout(metadataTimer.current);
    metadataTimer.current = null;
    for (const [path, editor] of editors.current) { const state = editor.capture(); if (state) editorViews.current[path] = state; }
    for(const [path,canvas] of canvases.current)canvasViews.current[path]=canvas.capture();
    for(const [path,drawing] of drawings.current)drawingViews.current[path]=drawing.capture();
    try {
      window.localStorage.setItem(workspaceKey.current, JSON.stringify({ ...workspaceSnapshot.current, editors: editorViews.current, previews: previewScrolls.current,canvases:canvasViews.current,drawings:drawingViews.current }));
      metadataWarning.current = false;
    } catch { if (!metadataWarning.current) { metadataWarning.current = true; setError("无法保存界面设置与标签恢复信息；笔记保存和恢复草稿仍按原流程处理。"); } }
  }
  flushWorkspaceRef.current = storeWorkspace;
  function scheduleWorkspace() {
    if (!workspaceReadyRef.current) return;
    if (metadataTimer.current) clearTimeout(metadataTimer.current);
    metadataTimer.current = setTimeout(() => flushWorkspaceRef.current(), 250);
  }
  useEffect(() => { scheduleWorkspace(); }, [workspaceReady, tabs, activeTab, panes, pinned, sidebarCollapsed, outlineOpen, sidebarWidth, outlineWidth, splitRatio, collapsedFolders, managedFoldersExpanded, modes, selected, sidebarView, taskPath, taskCategory, taskGroup, graphSettings, taskSettings]);
  useEffect(() => () => { workspaceReadyRef.current = false; if (metadataTimer.current) clearTimeout(metadataTimer.current); }, []);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 850px)");
    if (!media) return;
    const update = () => { setNarrow(media.matches); setMobileSidebar(false); setMobileOutline(false); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { const frame = requestAnimationFrame(() => editors.current.forEach((editor) => editor.measure())); return () => cancelAnimationFrame(frame); }, [preferences, sidebarWidth, outlineWidth, splitRatio, panes.ratio, dualPane, showSidebar, outlineOpen]);
  useEffect(() => {
    const image = (event: Event) => { const value = (event as CustomEvent).detail; if (typeof value?.src === "string" && /^data:image\//i.test(value.src)) setImagePreview({ src: value.src, name: String(value.name ?? "图片") }); };
    const pdf = (event: Event) => {
      const value = (event as CustomEvent<{ path: string; page: number }>).detail;
      if (typeof value?.path === "string" && isPdfPath(value.path)) setPdfPreview((current) => current ?? value);
    };
    const copy = (event: Event) => { if (typeof (event as CustomEvent).detail === "string") setCopyText((event as CustomEvent).detail); };
    window.addEventListener(imagePreviewEvent, image); window.addEventListener(pdfPreviewEvent, pdf); window.addEventListener(manualCopyEvent, copy);
    return () => { window.removeEventListener(imagePreviewEvent, image); window.removeEventListener(pdfPreviewEvent, pdf); window.removeEventListener(manualCopyEvent, copy); };
  }, []);
  const paths = useMemo(() => notePaths(entries), [entries]);
  const attachmentPaths=useMemo(()=>{
    const files:string[]=[];
    function collect(items:Entry[]){
      for(const entry of items){
        if(entry.issue)continue;
        if(entry.isDirectory)collect(entry.children);
        else if(!isDocument(entry.path)&&!entry.path.startsWith("PDF 标注/"))files.push(entry.path);
      }
    }
    collect(entries);
    return files;
  },[entries]);
  const documents=useMemo(()=>documentPaths(entries),[entries]);
  const drawingPaths=useMemo(()=>documents.filter(isDrawing),[documents]);
  const documentsRef=useRef(documents);documentsRef.current=documents;
  const taskCandidates = useMemo(() => taskFiles(entries), [entries]);
  const groups = useMemo(() => taskGroups(entries), [entries]);
  const info = useMemo(() => {
    const content = workspace === "notes" && !structuredActive ? session?.content ?? "" : "";
    if (!largeNote) return documentInfo(content);
    if (largeInfo && largeInfo.path === currentPath && largeInfo.content === content) return largeInfo.info;
    return { ...documentSize(content), words: null, headings: [] };
  }, [workspace, session?.content, structuredActive, largeNote, largeInfo, currentPath]);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const needsGraph = visibleTab(graphTabId);
  const needsRelations = needsGraph || showSidebar && sidebarView === "backlinks" && !!session && isMarkdown(session.note.path);
  const knowledge = useKnowledgeSnapshot(vault, paths, needsRelations || showSidebar && (sidebarView === "search" || sidebarView === "tags"), knowledgeRevision, vaultGeneration);
  const searchAnalysis = useVaultAnalysis(canvasScope);
  const graphAnalysis = useVaultAnalysis(canvasScope);
  const dashboardAnalysis = useVaultAnalysis(canvasScope);
  const [calculatedRelations, setCalculatedRelations] = useState<{
    scope: string; paths: string[]; notes: Note[]; answer?: RelationAnswer; error?: string;
  } | null>(null);
  const recentRelations = calculatedRelations?.scope === canvasScope ? calculatedRelations : null;
  const relationsReady = recentRelations?.paths === paths && recentRelations.notes === knowledge.notes &&
    (!needsGraph || !!recentRelations.answer?.graph || !!recentRelations.error);
  useEffect(() => {
    if (!vault || !needsRelations || relationsReady || knowledge.loading && !knowledge.notes.length) return;
    const job = new AbortController(), notes = knowledge.notes;
    void graphAnalysis.run({ kind: "relations", paths, graph: needsGraph }, notes, job.signal).then(answer => {
      if (!job.signal.aborted && answer.kind === "relations") setCalculatedRelations({ scope: canvasScope, paths, notes, answer });
    }).catch(cause => {
      if (!job.signal.aborted) setCalculatedRelations({ scope: canvasScope, paths, notes, error: String(cause) });
    });
    return () => job.abort();
  }, [vault, needsRelations, needsGraph, relationsReady, knowledge.notes, knowledge.loading, graphAnalysis, canvasScope, paths]);
  const relations = recentRelations?.answer?.relations ?? emptyRelations;
  const graph = recentRelations?.answer?.graph ?? emptyGraph;
  const relatedLoading = knowledge.loading || needsRelations && !relationsReady;
  const relatedErrors = relationsReady && recentRelations?.error ?
    [...knowledge.errors, { path: "笔记关联", error: recentRelations.error }] : knowledge.errors;
  const scannedTasks = useKnowledgeSnapshot(vault, taskCandidates, tabs.includes(tasksTabId), knowledgeRevision, vaultGeneration);
  const taskSnapshot = useMemo(() => {
    const notes = new Map(scannedTasks.notes.map((note) => [note.path, note]));
    for (const current of Object.values(sessions)) {
      if (taskCandidates.includes(current.note.path) && !recoveries[current.note.path]) notes.set(current.note.path, { ...current.note, content: current.content });
    }
    return { ...scannedTasks, notes: [...notes.values()] };
  }, [scannedTasks, sessions, recoveries, taskCandidates]);
  const taskSession = taskPath ? sessions[taskPath] ?? null : null;
  const taskRecovery = taskPath ? recoveries[taskPath] ?? null : null;
  const taskCategories = useMemo(() => {
    const found = new Set(taskSnapshot.notes.filter((note) => isTaskCategoryDocument(note.content)).map((note) => note.path));
    if (session && taskCandidates.includes(session.note.path)) {
      if (isTaskCategoryDocument(session.content)) found.add(session.note.path);
      else found.delete(session.note.path);
    }
    return [...found].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [taskCandidates, taskSnapshot.notes, session]);
  const clearPendingAnchor = useCallback(() => {pendingAnchorNavigation.current=null;setPendingAnchor(undefined);}, []);
  const openLinkedNote = useCallback((path: string, anchor?: string) => {
    cancelDocumentNavigation();
    const sequence=navigationSequence.current,generation=vaultGeneration.current,origin=activeTabRef.current;
    const valid=()=>sequence===navigationSequence.current&&generation===vaultGeneration.current&&activeTabRef.current===origin&&!busyRef.current;
    void openNoteRef.current(path,valid).then(opened=>{
      if(opened&&sequence===navigationSequence.current&&generation===vaultGeneration.current&&activeTabRef.current===path){
        if(anchor&&isMarkdown(path))setMode("preview");pendingAnchorNavigation.current=sequence;setPendingAnchor(isMarkdown(path)?anchor:undefined);
      }
    });
  }, []);
  const openWiki = useCallback((target:string,source?:string,chosen?:string)=>{void wikiRequestRef.current(target,source??"",chosen);},[]);
  function cachedHeadings(path:string,content:string){
    const prior=headingCache.current.get(path);if(prior?.content===content)return prior.headings;
    const headings=headingIndex(content);
    if(headingCache.current.size>=128)headingCache.current.delete(headingCache.current.keys().next().value!);
    headingCache.current.set(path,{content,headings});return headings;
  }
  function cachedBlocks(path:string,content:string){
    const prior=blockCache.current.get(path);if(prior?.content===content)return prior.blocks;
    const blocks=blockIndex(content);if(blockCache.current.size>=128)blockCache.current.delete(blockCache.current.keys().next().value!);
    blockCache.current.set(path,{content,blocks});return blocks;
  }
  const wikiServices=useMemo<WikiServices>(()=>({
    lookup(path){
      if(recoveriesRef.current[path])return undefined;
      const content=sessionsRef.current[path]?.content??knowledge.notes.find(note=>note.path===path)?.content;
      return content===undefined?undefined:cachedHeadings(path,content);
    },
    lookupBlocks(path){
      if(recoveriesRef.current[path])return undefined;
      const content=sessionsRef.current[path]?.content??knowledge.notes.find(note=>note.path===path)?.content;
      return content===undefined?undefined:cachedBlocks(path,content);
    },
    async load(target,source){
      const generation=vaultGeneration.current,pathsKey=pathsRef.current.join("\0"),parsed=resolveWikiTarget(target,source,pathsRef.current);
      if(parsed.invalid)throw new Error(!parsed.file?"同篇标题仅用于 Markdown 笔记":"Wiki 路径无效");
      if(parsed.candidates.length!==1)throw new Error(parsed.candidates.length?"请先明确同名文件的路径":"找不到目标笔记");
      const path=parsed.candidates[0];
      if(recoveriesRef.current[path])throw new Error("目标有待确认草稿，请先打开并处理");
      let content=sessionsRef.current[path]?.content;
      if(content===undefined)content=(await desktop.read(path)).content;
      if(generation!==vaultGeneration.current)throw new Error("知识库已切换，标题读取已取消");
      if(pathsKey!==pathsRef.current.join("\0"))throw new Error("文件路径已变化，标题读取已取消");
      if(recoveriesRef.current[path])throw new Error("目标有待确认草稿，请先处理");
      return {path,headings:cachedHeadings(path,sessionsRef.current[path]?.content??content)};
    },
    async loadBlocks(target,source){
      const generation=vaultGeneration.current,pathsKey=pathsRef.current.join("\0"),parsed=resolveWikiTarget(target,source,pathsRef.current);
      if(parsed.invalid||parsed.candidates.length!==1)throw new Error(parsed.candidates.length>1?"请先明确同名文件的路径":"找不到明确的目标笔记");
      const path=parsed.candidates[0];if(path===source&&recoveriesRef.current[path])throw new Error("目标有待确认草稿，请先处理");
      const content=path===source&&sessionsRef.current[path]?sessionsRef.current[path].content:(await desktop.read(path)).content;
      if(generation!==vaultGeneration.current||pathsKey!==pathsRef.current.join("\0"))throw new Error("知识库或文件路径已变化，块读取已取消");
      if(path===source&&recoveriesRef.current[path])throw new Error("目标有待确认草稿，请先处理");
      return {path,blocks:cachedBlocks(path,path===source?sessionsRef.current[path]?.content??content:content)};
    },
    feedback(value,source){if(currentPathRef.current===source)setNotice(value);}
  }),[knowledge.notes,sessions,recoveries,canvasScope]);

  async function copyHeading(heading:HeadingEntry){
    const current=sessionRef.current;
    if(!current||!isMarkdown(current.note.path)||recoveryRef.current)return;
    try{
      const latest=cachedHeadings(current.note.path,current.content).find(item=>item.id===heading.id&&item.from===heading.from);
      if(!latest)throw new Error("标题已变化，请重新选择");
      const copied=await copyWikiText(formatWikiHeading(current.note.path,latest,[...new Set([...pathsRef.current,current.note.path])]));
      setNotice(copied?"已复制 Wiki 标题链接。":"请在手动复制窗口中复制标题链接。");
    }catch(cause){setError(message(cause));}
  }
  async function copyBlock(){
    const current=sessionRef.current,path=current?.note.path;
    if(!current||!path||!isMarkdown(path)){setError("请先打开 Markdown 笔记");return;}
    if(recoveryRef.current){setError("请先恢复或丢弃待确认的草稿");return;}
    if(busyRef.current){setError("文件操作进行中，请稍后重试");return;}
    try{
      if((modes[path]??preferencesRef.current.defaultMode)==="preview")throw new Error("请在编辑或源码视图选择要复制的块");
      const result=editors.current.get(path)?.blockLink?.(current.content,[...new Set([...pathsRef.current,path])]);
      if(!result)throw new Error("编辑器尚未就绪，请重试");
      const copied=await copyWikiText(result.link);
      setNotice((copied?"已复制块链接。":"请在手动复制窗口中复制块链接。")+(result.created?" 已插入块标记，请等待笔记保存。":""));
    }catch(cause){setError(message(cause));}
  }
  async function copyPreviewBlock(path:string,kind:BlockKind,from:number,expected:string){
    const current=sessionsRef.current[path];if(!current||activeTabRef.current!==path)return;
    if(recoveriesRef.current[path]){setError("请先恢复或丢弃待确认的草稿");return;}
    if(busyRef.current){setError("文件操作进行中，请稍后重试");return;}
    try{
      if(current.content!==expected)throw new Error("笔记内容已变化，请重新选择块");
      const index=cachedBlocks(path,current.content),block=index.blocks.find(item=>item.kind===kind&&item.from===from);
      if(!block||!block.markers.length)throw new Error("该块尚无标记，请在编辑或源码视图创建块链接");
      if(block.markers.length!==1||findBlock(index,block.markers[0].id).status!=="resolved")throw new Error("块 ID 重复或归属不明确，请先调整原文");
      const link=formatWikiBlock(path,block.markers[0].id,block.snippet,[...new Set([...pathsRef.current,path])]);
      const copied=await copyWikiText(link);setNotice(copied?"已复制块链接。":"请在手动复制窗口中复制块链接。");
    }catch(cause){setError(message(cause));}
  }
  function cancelDocumentNavigation(){
    if(searchFlight.current!==null)setNotice("搜索定位已取消。");
    ++navigationSequence.current;setWikiJump(null);setWikiChoices(null);pendingAnchorNavigation.current=null;setPendingAnchor(undefined);setHeadingJumps(previous=>Object.keys(previous).length?{}:previous);
    searchFlight.current=null;setSearchJump(null);searchMarkRef.current=null;setSearchMark(null);setSearchStale(null);setSearchPreviewStatus(null);
  }
  async function requestSearch(choice:SearchChoice,source=false){
    if(busyRef.current||searchContextRef.current!==choice.context)return;
    cancelDocumentNavigation();setError("");
    const sequence=navigationSequence.current,generation=vaultGeneration.current,origin=activeTabRef.current,pathsKey=pathsRef.current.join("\0"),path=choice.file.path;
    searchFlight.current=sequence;
    setNotice("正在打开搜索结果："+path);
    const valid=()=>sequence===navigationSequence.current&&generation===vaultGeneration.current&&searchContextRef.current===choice.context&&pathsKey===pathsRef.current.join("\0")&&activeTabRef.current===origin&&!busyRef.current;
    const opened=await openNote(path,undefined,"notes",valid);
    if(sequence!==navigationSequence.current||generation!==vaultGeneration.current)return;
    if(!opened||activeTabRef.current!==path){searchFlight.current=null;return;}
    if(!choice.hit){searchFlight.current=null;setNotice("已打开搜索文件："+path);return;}
    if(source)setMode("source",path);
    setSearchJump({choice,sequence,generation,path});
  }
  function searchCurrentContent(path:string){
    const current=sessionsRef.current[path];if(!current||recoveriesRef.current[path])return;
    cancelDocumentNavigation();
    setSearchLocal({note:{...current.note,content:current.content},label:current.conflict?"冲突分支快照":needsDraft(current)?"未保存编辑快照":"已确认内容快照"});
    setSidebarView("search");
  }
  function searchInSource(){
    const mark=searchMarkRef.current,context=searchContextRef.current;if(!mark||!context||activeTabRef.current!==mark.path)return;
    const current=sessionsRef.current[mark.path];if(!current)return;
    const hit=createSearchHit(mark.content,{from:mark.from,to:mark.to});
    void requestSearch({context,file:{path:mark.path,note:{...current.note,content:mark.content},pathMatched:false,hits:[hit],truncated:false,unread:false},hit},true);
  }
  useEffect(()=>{
    if(sidebarView!=="search"||!showSidebar)setSearchLocal(null);
  },[sidebarView,showSidebar]);
  useEffect(()=>{
    const mark=searchMarkRef.current;
    if(mark&&(activeTab!==mark.path||sessions[mark.path]?.content!==mark.content))clearSearchHighlight(mark.serial);
  },[sessions,activeTab,clearSearchHighlight]);
  useEffect(()=>{
    if(!searchJump)return;
    const {choice,path,sequence,generation}=searchJump;
    if(sequence!==navigationSequence.current||generation!==vaultGeneration.current||activeTab!==path||searchContextRef.current!==choice.context){setSearchJump(null);return;}
    if(recoveries[path]||settingsOpen||palette||dialog||historyJob||webdavOpen)return;
    const current=sessions[path];if(!current||!choice.hit||!choice.file.note)return;
    const range=resolveSearchHit(choice.file.note,choice.hit,current.content,choice.context.query,choice.context.options);
    if(!range){
      setNotice("搜索结果已过期，无法唯一确认原命中。");setSearchStale({path,query:choice.context.query});searchFlight.current=null;setSearchJump(null);return;
    }
    const highlight:SearchHighlight={path,content:current.content,...range,serial:sequence,query:choice.context.query},view=modes[path]??preferencesRef.current.defaultMode;
    if(view!=="preview"&&!editors.current.get(path)?.revealMatch?.(highlight))return;
    searchMarkRef.current=highlight;setSearchMark(highlight);setSearchPreviewStatus(null);searchFlight.current=null;setSearchJump(null);
    setNotice("已定位搜索命中："+path);
  },[searchJump,sessions,recoveries,activeTab,modes,editorReady,settingsOpen,palette,dialog,historyJob,webdavOpen]);

  async function requestWiki(target:string,source:string,chosen?:string){
    if(busyRef.current)return;
    cancelDocumentNavigation();
    const sequence=navigationSequence.current,generation=vaultGeneration.current,origin=activeTabRef.current,pathsKey=pathsRef.current.join("\0");
    setError("");setWikiJump(null);setWikiChoices(null);
    const known=[...new Set([...pathsRef.current,...Object.keys(sessionsRef.current).filter(isMarkdown)])];
    const parsed=resolveWikiTarget(target,source,known);
    if(parsed.invalid){setError(!parsed.file?"同篇标题仅用于 Markdown 笔记":"Wiki 链接路径无效。");return;}
    if(!parsed.candidates.length){setError("找不到 Wiki 链接目标：“"+target+"”。");return;}
    const problem=headingProblem(parsed.fragment);if(problem){setError(problem+"："+target);return;}
    if(parsed.candidates.length>1&&!chosen){setWikiChoices({target,source,paths:parsed.candidates,sequence});return;}
    const path=chosen??parsed.candidates[0];
    if(!parsed.candidates.includes(path)){setError("目标文件已变化，请重新选择。");return;}
    const valid=()=>sequence===navigationSequence.current&&generation===vaultGeneration.current&&pathsKey===pathsRef.current.join("\0")&&activeTabRef.current===origin&&!busyRef.current;
    const opened=await openNote(path,undefined,"notes",valid);
    if(!opened||sequence!==navigationSequence.current||generation!==vaultGeneration.current||activeTabRef.current!==path)return;
    if(parsed.fragment!==null)setWikiJump({sequence,generation,path,fragment:parsed.fragment});
  }
  useEffect(()=>{
    if(settingsOpen||palette||widgetDrawer||historyJob||webdavOpen||imagePreview||pdfPreview||batchPicker||batchExport||slides||copyText!==null||renaming||movePicker||dialog&&!recovery)cancelDocumentNavigation();
  },[settingsOpen,palette,widgetDrawer,historyJob,webdavOpen,imagePreview,pdfPreview,batchPicker,batchExport,slides,copyText,renaming,movePicker,dialog]);
  useEffect(()=>{
    if(!wikiJump)return;
    const {path,sequence,generation,fragment}=wikiJump;
    if(sequence!==navigationSequence.current||generation!==vaultGeneration.current||activeTab!==path){setWikiJump(null);return;}
    if(recoveries[path]||settingsOpen||palette||dialog||historyJob||webdavOpen)return;
    const current=sessions[path];if(!current)return;
    const isBlock=fragment.startsWith("^"),block=isBlock?findBlock(cachedBlocks(path,current.content),fragment.slice(1)):null;
    const heading=isBlock?undefined:findHeading(cachedHeadings(path,current.content),fragment);
    if(isBlock&&block?.status!=="resolved"){setError((block?.status==="ambiguous"?"块 ID 重复或归属不明确":"文件存在，块不存在")+"："+path+"#"+fragment);setWikiJump(null);return;}
    if(!isBlock&&!heading){setError("文件存在，标题不存在："+path+"#"+fragment);setWikiJump(null);return;}
    const from=isBlock?block!.block!.from:heading!.from;
    const view=modes[path]??preferencesRef.current.defaultMode;
    if(view!=="preview"&&!editors.current.get(path)?.reveal(from,current.content))return;
    if(view==="preview"||view==="split")setHeadingJumps(previous=>({...previous,[path]:{from,serial:++jumpSerial.current,content:current.content,navigation:sequence,...(isBlock?{kind:"block" as const}:{})}}));
    setNotice(isBlock?"已定位块："+fragment+"（"+path+"）":"已定位标题："+heading!.text+"（"+path+"）");setWikiJump(null);
  },[wikiJump,sessions,recoveries,activeTab,modes,editorReady,settingsOpen,palette,dialog,historyJob,webdavOpen]);


  function togglePanel(next: SidebarView) {
    const target = next === "tasks" ? "tasks" : "notes";
    const collapse = sidebarView === next && workspace === target && showSidebar;
    if (target === "tasks") showTab(tasksTabId);
    else if (workspace !== "notes") {
      const note = lastNoteTab.current && tabsRef.current.includes(lastNoteTab.current) ? lastNoteTab.current : tabsRef.current.find(isFileTab);
      if (note) showTab(note);
      else { setActiveTabNow(null); setWorkspace("notes"); activateDocument(null); }
    }
    setSidebarView(next); setSidebarCollapsed(collapse);
    if (narrow) { setMobileSidebar(!collapse); setMobileOutline(false); }
  }
  function toggleSidebar() {
    if (narrow && preferences.autoCollapseSidebar) setMobileSidebar(!showSidebar);
    else { setSidebarCollapsed(showSidebar); if (narrow) setMobileSidebar(false); }
    if (narrow && !showSidebar) setMobileOutline(false);
  }
  function toggleOutline() {
    if (largeNote) {
      setLargeOutline(showOutline ? null : currentPath);
      if (narrow) setMobileSidebar(false);
      return;
    }
    if (narrow) { setMobileOutline(!mobileOutline); setMobileSidebar(false); if (!mobileOutline && !preferences.autoCollapseSidebar) setSidebarCollapsed(true); }
    else setOutlineOpen(!outlineOpen);
  }
  function revealInTree(path: string) {
    setSidebarView("files"); setSidebarCollapsed(false); if (narrow) setMobileSidebar(true);
    const [root] = path.split("/", 1);
    if (entries.some(entry => entry.path === root && isTaskOrJournalRoot(entry))) setManagedFoldersExpanded(true);
    setCollapsedFolders((previous) => previous.filter((folder) => !path.startsWith(`${folder}/`)));
    setSelected(path);
  }
  function beginRename(path: string) {
    if (busyRef.current) return;
    if (Object.values(sessionsRef.current).some((item) => affected(item.note.path, path) && needsDraft(item)) || Object.keys(recoveriesRef.current).some((item) => affected(item, path)) || drafts.some((draft) => affected(draft.path, path))) {
      setError("请先保存或另存当前笔记，并处理待恢复草稿，再移动或删除它。"); return;
    }
    setRenaming(path);
  }

  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", escape); };
  }, [fileMenu]);

  function putSession(next: Session) {
    const path = next.note.path;
    sessionsRef.current = { ...sessionsRef.current, [path]: next };
    setSessions(sessionsRef.current);
    if (currentPathRef.current === path) sessionRef.current = next;
  }
  function activateDocument(path: string | null) {
    currentPathRef.current = path; setCurrentPath(path);
    sessionRef.current = path ? sessionsRef.current[path] ?? null : null;
    recoveryRef.current = path ? recoveriesRef.current[path] ?? null : null;
  }
  function setCurrent(next: Session | null) { if (next) putSession(next); activateDocument(next?.note.path ?? null); }
  function setRecoveryNow(next: Recovery | null, path = currentPathRef.current) {
    if (!path) return;
    const updated = { ...recoveriesRef.current };
    if (next) updated[path] = next; else delete updated[path];
    recoveriesRef.current = updated; setRecoveries(updated);
    if (currentPathRef.current === path) recoveryRef.current = next;
  }
  function setPaneLayout(next: NotePanes) { panesRef.current = next; setPanes(next); }
  function setOpenTabs(next: string[]) { const ordered = orderTabs(next, pinnedRef.current); tabsRef.current = ordered; setTabs(ordered); setPaneLayout(normalizeNotePanes(panesRef.current, ordered, activeTabRef.current)); }
  function setPins(next: string[]) { pinnedRef.current = next; setPinned(next); setOpenTabs(tabsRef.current); }
  function togglePin(id: string) { setPins(pinnedRef.current.includes(id) ? pinnedRef.current.filter((path) => path !== id) : [...pinnedRef.current, id]); }
  function setActiveTabNow(id: string | null) {
    activeTabRef.current = id; setActiveTab(id);
    const next = normalizeNotePanes(panesRef.current, tabsRef.current, id);
    setPaneLayout(id === null ? { ...next, leftActive: null } : next);
  }
  function moveTabToPane(path: string, right: boolean) {
    if (busyRef.current || !isMarkdown(path) || !tabsRef.current.includes(path)) return;
    const current = panesRef.current;
    setPaneLayout(normalizeNotePanes({ ...current, right: right ? [...current.right, path] : current.right.filter(id => id !== path) }, tabsRef.current, path));
    showTab(path);
  }
  async function openOnRight(path: string) {
    if (busyRef.current || !isMarkdown(path)) return;
    if (tabsRef.current.includes(path)) moveTabToPane(path, true);
    else {
      const leftActive = panesRef.current.leftActive;
      if (await openNote(path)) {
        moveTabToPane(path, true);
        if (leftActive && leftActive !== path) setPaneLayout(normalizeNotePanes({ ...panesRef.current, leftActive }, tabsRef.current, path));
      }
    }
  }
  function mergePanes() {
    if (busyRef.current) return;
    setPaneLayout(normalizeNotePanes({ ...panesRef.current, right: [] }, tabsRef.current, activeTabRef.current));
  }
  function dragTabOver(event: DragEvent) {
    if (busyRef.current || !draggedTab.current || !isMarkdown(draggedTab.current)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
  }
  function dropTab(event: DragEvent, right: boolean) {
    if (!event.dataTransfer.types.includes(workspaceTabType)) return;
    event.preventDefault(); event.stopPropagation();
    const path = transferredTab(event.dataTransfer, canvasScope);
    draggedTab.current = null;
    if (path) moveTabToPane(path, right);
  }
  function remapPanes(map: (path: string) => string) { setPaneLayout(remapNotePanes(panesRef.current, map)); }
  function focusVisibleTab(path: string) {
    if (!busyRef.current && activeTabRef.current !== path && (panesRef.current.leftActive === path || panesRef.current.rightActive === path)) showTab(path);
  }
  function setMode(next: ViewMode, path = currentPathRef.current) {
    if (!path||!isMarkdown(path)) return;
    setModes((previous) => ({ ...previous, [path]: next }));
    if (next === "preview" || next === "split") setPreviewed((previous) => previous.includes(path) ? previous : [...previous, path]);
  }
  function setTaskDocument(path: string | null) { taskPathRef.current = path; setTaskPath(path); }
  function showTab(id: string, keepNavigation=false) {
    if(!keepNavigation)cancelDocumentNavigation();
    const previousPath = currentPathRef.current, previousTab = activeTabRef.current;
    if (previousPath) { const state = editors.current.get(previousPath)?.capture(); if (state) editorViews.current[previousPath] = state; const canvas=canvases.current.get(previousPath);if(canvas)canvasViews.current[previousPath]=canvas.capture();const drawing=drawings.current.get(previousPath);if(drawing)drawingViews.current[previousPath]=drawing.capture(); }
    const previous = sessionRef.current;
    if (previous && needsDraft(previous) && !recoveryRef.current) persist(previous).catch(() => {});
    const newTab = !tabsRef.current.includes(id);
    if (newTab) {
      const openRight = !!previousTab && panesRef.current.right.includes(previousTab) && isMarkdown(id);
      setOpenTabs([...tabsRef.current, id]);
      if (openRight) setPaneLayout(normalizeNotePanes({ ...panesRef.current, right: [...panesRef.current.right, id] }, tabsRef.current, id));
    }
    if (isMarkdown(id)) {
      setModes((previous) => !newTab && previous[id] ? previous : { ...previous,
        [id]: initialNoteMode(sessionsRef.current[id]?.content ?? "", previous[id] ?? preferencesRef.current.defaultMode) });
    }
    setActiveTabNow(id);
    if (id === tasksTabId) {
      setWorkspace("tasks"); activateDocument(taskPathRef.current); setSidebarView("tasks");
    } else if (id === graphTabId) {
      if (previousPath && previousTab !== graphTabId && !!previousTab && isMarkdown(previousTab)) setGraphSettings((previous) => ({ ...previous, center: previousPath }));
      setWorkspace("graph"); activateDocument(null);
      if (sidebarView === "tasks" || sidebarView === "backlinks") setSidebarView("files");
    } else {
      if(isMarkdown(id)){lastNoteTab.current = id; graphContextNote.current = id;} setWorkspace("notes"); activateDocument(id); setSelected(id);
      if (sidebarView === "tasks") setSidebarView("files");
    }
  }
  function openGraph(mode?: GraphSettings["mode"]) {
    if (!vault || busyRef.current) return;
    const center = workspace === "notes"&&isMarkdown(currentPathRef.current??"") ? currentPathRef.current : lastNoteTab.current;
    setGraphSettings((previous) => ({ ...previous, ...(mode ? { mode } : {}), center: center ?? previous.center }));
    showTab(graphTabId);
  }
  function openReference(path: string, from?: number) {
    cancelDocumentNavigation();
    const generation=vaultGeneration.current,sequence=navigationSequence.current,origin=activeTabRef.current;
    const valid=()=>generation===vaultGeneration.current&&sequence===navigationSequence.current&&activeTabRef.current===origin&&!busyRef.current;
    void openNote(path,undefined,"notes",valid).then(opened=>{
      if(!opened||from===undefined||generation!==vaultGeneration.current||sequence!==navigationSequence.current||recoveriesRef.current[path])return;
      setHeadingJumps(previous=>({...previous,[path]:{from,serial:++jumpSerial.current,navigation:sequence,content:sessionsRef.current[path]?.content}}));
      requestAnimationFrame(()=>{if(generation===vaultGeneration.current&&sequence===navigationSequence.current&&activeTabRef.current===path)editors.current.get(path)?.reveal(from);});
    });
  }
  function showDocument(path: string, view: Workspace, keepNavigation=false) {
    if (view === "tasks") { setTaskDocument(path); showTab(tasksTabId,keepNavigation); }
    else showTab(path,keepNavigation);
  }
  function removeDocuments(paths: string[]) {
    const next = { ...sessionsRef.current }, restored = { ...recoveriesRef.current };
    for (const path of paths) { cancelTimers(path); delete next[path]; delete restored[path]; }
    sessionsRef.current = next; setSessions(next); recoveriesRef.current = restored; setRecoveries(restored);
    setSaveErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([path])=>!paths.includes(path))));
    if (currentPathRef.current && paths.includes(currentPathRef.current)) activateDocument(null);
  }
  function setWorking(value: boolean) { if(value)cancelDocumentNavigation(); busyRef.current = value; setBusy(value); }

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(preferencesKey);
      const saved = normalizePreferences(raw ? JSON.parse(raw) : null, window.localStorage.getItem(themeKey));
      preferencesRef.current = saved; setPreferences(saved);
    } catch {
      setError("无法读取软件设置，已使用默认设置。");
    }
  }, []);

  useEffect(() => desktop.onRelocationRecovered?.(async (result, incomplete) => {
    await recoveryRelocationRef.current(result, incomplete);
    await refreshLists(); resumePending();
  }), [desktop]);

  useEffect(() => {
    if (!web || !vault || !workspaceReady) return;
    const path = new URLSearchParams(location.search).get("note");
    if (path) void openNoteRef.current(path);
  }, [vault, web, workspaceReady]);

  function updatePreferences(value: AppPreferences) {
    const next = normalizePreferences(value);
    preferencesRef.current = next; setPreferences(next);
    setWidgetDrawer(current => (current === "heatmap" && !next.showNoteHeatmap) || (current === "dashboard" && !next.showNoteDashboard) ? null : current);
    try { window.localStorage.setItem(preferencesKey, JSON.stringify(next)); window.localStorage.setItem(themeKey, next.theme); }
    catch { setError("设置已生效，但无法保存到当前设备。"); }
  }
  function toggleTheme() { updatePreferences(toggleThemePreference(preferencesRef.current)); }
  function cancelTimers(path?: string) {
    for (const timers of [draftTimers.current, saveTimers.current]) {
      for (const [key, timer] of timers) if (!path || key === path) { clearTimeout(timer); timers.delete(key); }
    }
  }

  function queueDraft(draft: Draft): Promise<void> {
    const next = draftQueue.current.catch(() => {}).then(() => desktop.writeDraft(draft));
    draftQueue.current = next;
    next.then(() => {
      draftErrors.current.delete(draft.path); setDraftError([...draftErrors.current.values()].join("\n"));
      setDrafts((previous) => [...previous.filter((item) => draft.recoveryId && item.recoveryId ? item.recoveryId !== draft.recoveryId : item.path !== draft.path), draft].sort((a, b) => a.path.localeCompare(b.path)));
    }).catch((cause) => { draftErrors.current.set(draft.path, `草稿未能保存：${message(cause)}（${draft.path}）。请保持窗口打开并重试。`); setDraftError([...draftErrors.current.values()].join("\n")); });
    return next;
  }

  function queueRemoval(path: string): Promise<void> {
    const next = draftQueue.current.catch(() => {}).then(async () => {
      await desktop.removeDraft(path);
      if (web) setDrafts(await desktop.drafts());
    });
    draftQueue.current = next;
    next.then(() => {
      draftErrors.current.delete(path); setDraftError([...draftErrors.current.values()].join("\n"));
      if (!web) setDrafts((previous) => previous.filter((item) => item.path !== path));
    }).catch((cause) => { draftErrors.current.set(path, `无法清理恢复草稿：${message(cause)}（${path}）`); setDraftError([...draftErrors.current.values()].join("\n")); });
    return next;
  }

  function persist(sessionToSave: Session) {
    return queueDraft({ path: sessionToSave.note.path, content: sessionToSave.content, baseVersion: sessionToSave.note.version });
  }

  async function flushPath(path: string) {
    await flushDocumentImports(path);
    cancelTimers(path);
    if (saveFlights.current.has(path)) await saveFlights.current.get(path);
    cancelTimers(path);
    for (;;) {
      const current = sessionsRef.current[path];
      if (current && needsDraft(current) && !recoveriesRef.current[path]) await persist(current);
      else await draftQueue.current.catch(() => {});
      if (sessionsRef.current[path] === current) return;
    }
  }

  async function flushCurrent() {
    // Vault changes and closing the window protect every document, including
    // inactive tabs and categories opened only in the task workspace.
    flushWorkspaceRef.current();
    await organizationFlight.current?.catch(() => {});
    await Promise.all([...editors.current.values(),...canvases.current.values(),...drawings.current.values()].map((editor) => editor.flushImports()));
    cancelTimers();
    await Promise.all([...saveFlights.current.values()]);
    cancelTimers();
    for (;;) {
      const before = sessionsRef.current;
      for (const current of Object.values(before)) {
        if (needsDraft(current) && !recoveriesRef.current[current.note.path]) await persist(current);
      }
      await draftQueue.current.catch(() => {});
      if (sessionsRef.current === before) return;
    }
  }
  flushRef.current = flushCurrent;

  function schedule(current: Session) {
    const path = current.note.path;
    cancelTimers(path);
    if (!needsDraft(current)) { queueRemoval(path).catch(() => {}); return; }
    draftTimers.current.set(path, setTimeout(() => {
      draftTimers.current.delete(path);
      const latest = sessionsRef.current[path];
      if (latest && needsDraft(latest) && !recoveriesRef.current[path]) persist(latest).catch(() => {});
    }, 300));
    if (!current.conflict&&!documentSaveIssue(path,current.content)) saveTimers.current.set(path, setTimeout(() => {
      saveTimers.current.delete(path); void saveRef.current(path);
    }, Math.max(preferencesRef.current.autoSaveDelay, (retryAfter.current.get(path) ?? 0) - Date.now())));
  }

  useEffect(() => {
    for (const current of Object.values(sessionsRef.current)) {
      const path = current.note.path;
      if (needsDraft(current) && !recoveriesRef.current[path]) schedule(current);
    }
  }, [preferences.autoSaveDelay]);

  function resumePending(path?: string) {
    const pending = path ? [sessionsRef.current[path]].filter(Boolean) : Object.values(sessionsRef.current);
    for (const current of pending) {
      const key = current.note.path;
      if (needsDraft(current) && !recoveriesRef.current[key] && !saveFlights.current.has(key) && !saveTimers.current.has(key)) schedule(current);
    }
  }

  function changeContent(value: string, path = currentPathRef.current) {
    if (!path) return;
    const current = sessionsRef.current[path];
    if (!current || value === current.content || recoveriesRef.current[path]) return;
    if(path===currentPathRef.current)cancelDocumentNavigation();
    if(!needsDraft(current))setSaveErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>key!==path)));
    if(searchMarkRef.current?.path===path)clearSearchHighlight(searchMarkRef.current.serial);
    const next = { ...current, content: value };
    putSession(next); schedule(next);
  }

  function saveCurrent(path = currentPathRef.current, allowBusy = false): Promise<void> {
    if (!path) return Promise.resolve();
    const flight = saveFlights.current.get(path);
    if (flight) return flight;
    const snapshot = sessionsRef.current[path];
    if (!snapshot || (busyRef.current && !allowBusy) || recoveriesRef.current[path] || snapshot.conflict || !needsDraft(snapshot)) return Promise.resolve();
    const issue=documentSaveIssue(path,snapshot.content);
    if(issue){setError("当前"+documentName(path)+"无法安全保存："+issue+"；原文和本机草稿仍保留。");return Promise.resolve();}
    const generation = vaultGeneration.current;
    cancelTimers(path); setSavingPaths((previous) => [...previous.filter((item) => item !== path), path]); setError("");
    const pending = (async () => {
      try {
        await persist(snapshot).catch(() => {});
        const saved = await desktop.save(path, snapshot.content, snapshot.note.version);
        retryAfter.current.delete(path);
        if (generation !== vaultGeneration.current) return;
        setSaveErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>key!==path)));
        if(isMarkdown(path))setKnowledgeRevision((value) => value + 1);
        const current = sessionsRef.current[path];
        if (current?.note.version === snapshot.note.version) {
          const next = { note: saved, content: current.content, conflict: null };
          putSession(next);
          if (next.content === saved.content) await queueRemoval(path).catch(() => {});
          else await persist(next).catch(() => {});
        }
        setNotice(`已保存到${web ? "服务端" : "本地"}文件：${path}。`);
      } catch (cause) {
        if (generation !== vaultGeneration.current) return;
        setSaveErrors(previous=>({...previous,[path]:message(cause)}));
        const current = sessionsRef.current[path];
        if (current?.note.version === snapshot.note.version) {
          const next = { ...current, conflict: isTransient(cause) ? null : `保存未完成：${message(cause)}` };
          if (isTransient(cause)) retryAfter.current.set(path, Date.now() + 15000);
          putSession(next); persist(next).catch(() => {});
        }
        setError(`保存失败：${message(cause)}（${path}）。${isTransient(cause) ? "本机草稿已保留，恢复连接或登录后会重试。" : "当前编辑仍保留，可另存为新文件。"}`);
      } finally {
        if (generation === vaultGeneration.current) {
          saveFlights.current.delete(path);
          setSavingPaths((previous) => previous.filter((item) => item !== path));
          resumePending(path);
        }
      }
    })();
    saveFlights.current.set(path, pending);
    return pending;
  }
  saveRef.current = saveCurrent;

  async function refreshLists(organize = false) {
    let migration: Awaited<ReturnType<typeof organizeLegacyVault>> | null = null;
    if (organize && !web) {
      const pending = organizeLegacyVault(desktop);
      organizationFlight.current = pending;
      try { migration = await pending; }
      catch (cause) { setError(message(cause)); }
      finally { if (organizationFlight.current === pending) organizationFlight.current = null; }
    }
    const [files, stored] = await Promise.all([desktop.entries(), desktop.drafts()]);
    setEntries(files); setDrafts(stored);
    return migration;
  }

  async function restoreWorkspace(status: VaultStatus, moved: Parameters<typeof remapPath>[1] = [], active = () => true) {
    const key = status.vault ? workspaceStorageKey(runtime.kind, status.id ?? status.vault) : null;
    let saved = emptyWorkspace();
    if (key && preferencesRef.current.restoreWorkspace) {
      try { const raw = window.localStorage.getItem(key); if (raw) saved = normalizeWorkspace(JSON.parse(raw)); }
      catch { setError("上次的标签恢复信息无法读取；恢复草稿仍可从文件栏打开。"); }
    }
    if (moved.length) {
      const map = (path: string) => remapPath(path, moved);
      saved.panes = remapNotePanes(normalizeNotePanes(saved.panes, saved.tabs, saved.active), map);
      saved = { ...saved, graph: { ...saved.graph, center: saved.graph.center && map(saved.graph.center), folder: saved.graph.folder ? map(saved.graph.folder) : "" }, tabs: saved.tabs.map((id) => isFileTab(id) ? map(id) : id), active: saved.active && (isFileTab(saved.active) ? map(saved.active) : saved.active), pinned: saved.pinned.map((id) => isFileTab(id) ? map(id) : id), selected: saved.selected && map(saved.selected), collapsedFolders: saved.collapsedFolders.map(map), taskPath: saved.taskPath && map(saved.taskPath), taskCategory: saved.taskCategory && map(saved.taskCategory), taskGroup: saved.taskGroup && map(saved.taskGroup), modes: Object.fromEntries(Object.entries(saved.modes).map(([path, value]) => [map(path), value])), editors: Object.fromEntries(Object.entries(saved.editors).map(([path, value]) => [map(path), value])), previews: Object.fromEntries(Object.entries(saved.previews).map(([path, value]) => [map(path), value])) };
    }
    const loaded: Record<string, Session> = {}, restored: Record<string, Recovery> = {};
    let available: string[] = [], files: Entry[] = [];
    if (saved.tabs.length) {
      const [found, stored] = await Promise.all([desktop.entries(), desktop.drafts()]);
      files = found; available = documentPaths(found);
      for (const path of [...new Set([...saved.tabs.filter(isFileTab), ...(saved.tabs.includes(tasksTabId) && saved.taskPath ? [saved.taskPath] : [])])]) {
        const draft = stored.find((item) => item.path === path);
        if (!available.includes(path) && !draft) continue;
        let disk: Note | null = null;
        if (available.includes(path)) {
          try { disk = await desktop.read(path); }
          catch (cause) { if (!draft || isTransient(cause)) throw cause; }
        }
        if (disk) loaded[path] = { note: disk, content: disk.content, conflict: null };
        if (draft) restored[path] = { draft, disk };
      }
    }
    if (!active()) return;
    canvasViews.current=Object.fromEntries(Object.entries(saved.canvases??{}).map(([path,value])=>[remapPath(path,moved),value]));
    drawingViews.current=Object.fromEntries(Object.entries(saved.drawings??{}).map(([path,value])=>[remapPath(path,moved),value]));
    const opened = saved.tabs.filter((id) => !isFileTab(id) || loaded[id] || restored[id]);
    editorViews.current = saved.editors; previewScrolls.current = saved.previews;
    sessionsRef.current = loaded; setSessions(loaded); recoveriesRef.current = restored; setRecoveries(restored);
    setSidebarCollapsed(saved.sidebarCollapsed); setOutlineOpen(saved.outlineOpen); setSidebarWidth(saved.sidebarWidth); setOutlineWidth(saved.outlineWidth); setSplitRatio(saved.splitRatio); setCollapsedFolders(saved.collapsedFolders);
    setManagedFoldersExpanded(saved.managedFoldersExpanded);
    setPins(saved.pinned.filter((id) => opened.includes(id))); setOpenTabs(opened);
    setPaneLayout(normalizeNotePanes(saved.panes, opened, saved.active));
    setModes(Object.fromEntries(opened.filter(isMarkdown).map((id) => [id,
      initialNoteMode(loaded[id]?.content ?? "", saved.modes[id] ?? preferencesRef.current.defaultMode)])));
    setPreviewed([]); setMobileSidebar(false); setGraphSettings(saved.graph); setTaskSettings(saved.tasks);
    setTaskDocument(saved.taskPath && (loaded[saved.taskPath] || restored[saved.taskPath]) ? saved.taskPath : null);
    setTaskCategory(saved.taskCategory && available.includes(saved.taskCategory) ? saved.taskCategory : null);
    setTaskGroup(saved.taskGroup && findEntry(files, saved.taskGroup)?.isDirectory ? saved.taskGroup : null);
    const current = saved.active && opened.includes(saved.active) ? saved.active : opened[0];
    lastNoteTab.current = opened.find(isMarkdown) ?? null;
    if (current) showTab(current); else { setActiveTabNow(null); activateDocument(null); setWorkspace("notes"); }
    setSidebarView(current === tasksTabId ? "tasks" : saved.sidebarView === "tasks" ? "files" : saved.sidebarView);
    setWidgetDrawer(null);
    setSelected(saved.selected);
    workspaceKey.current = key; workspaceReadyRef.current = true; setWorkspaceReady(true);
    if (opened.length < saved.tabs.length) setNotice("已恢复工作区；不存在且没有恢复草稿的笔记已跳过。");
  }

  useEffect(() => {
    let active = true;
    desktop.status().then(async (status) => {
      if (!active) return;
      if (status.error) setError(status.error);
      if (status.vault) {
        setWorking(true);
        const migrated = await refreshLists(true);
        if (active) setNotice(migrated?.moves.length ? `已整理 ${migrated.moves.length} 项目录，备份位于 ${migrated.backup}。` : web ? "已连接服务端知识库；草稿保存在当前浏览器。" : "已重新打开上次的知识库。");
        await restoreWorkspace(status, migrated?.moves, () => active);
      }
      if (active) setVault(status.vault);
    }).catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setWorking(false); });
    return () => { active = false; cancelTimers(); };
  }, []);

  useEffect(() => {
    if (!runtime.nativeWindow) {
      const beforeUnload = (event: BeforeUnloadEvent) => {
        flushWorkspaceRef.current();
        if (pdfCloseBlocked.current) event.preventDefault();
        if (Object.values(sessionsRef.current).some(needsDraft) || organizationFlight.current || [...editors.current.values(),...canvases.current.values()].some((editor) => editor.hasPendingImports())) { void flushRef.current().catch(() => {}); event.preventDefault(); }
      };
      const visibility = () => { if (document.visibilityState === "hidden") void flushRef.current().catch((cause) => setDraftError(message(cause))); };
      const online = () => { retryAfter.current.clear(); resumePending(); };
      window.addEventListener("beforeunload", beforeUnload);
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("online", online);
      window.addEventListener("noto-session-restored", online);
      return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", online); window.removeEventListener("noto-session-restored", online); };
    }
    const nativeWindow = runtime.nativeWindow;
    let dispose: (() => void) | undefined;
    let active = true;
    nativeWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (pdfCloseBlocked.current) { setError("请先处理 PDF 阅读器中未保存的标注。"); return; }
      try {
        setWorking(true);
        await flushRef.current();
        await nativeWindow.destroy();
      } catch (cause) {
        setWorking(false);
        setDraftError(`无法保存恢复草稿，窗口保持打开：${message(cause)}`);
        resumePending();
      }
    }).then((unlisten) => { if (active) dispose = unlisten; else unlisten(); })
      .catch((cause) => setError(`无法启用关闭保护：${message(cause)}`));
    return () => { active = false; dispose?.(); };
  }, []);

  useEffect(() => {
    if (!vault) return;
    const interval = setInterval(async () => {
      if (refreshBusy.current || busyRef.current) return;
      const generation = vaultGeneration.current;
      refreshBusy.current = true;
      try {
        const files = await desktop.entries();
        if (generation !== vaultGeneration.current || busyRef.current) return;
        setEntries(files);
        await Promise.all(Object.values(sessionsRef.current).map(async (before) => {
          const path = before.note.path;
          if (saveFlights.current.has(path) || recoveriesRef.current[path] || before.conflict) return;
          try {
            const disk = await desktop.read(path);
            if (generation !== vaultGeneration.current || busyRef.current || saveFlights.current.has(path)) return;
            const current = sessionsRef.current[path];
            if (!current || current.note.version !== before.note.version || current.conflict || recoveriesRef.current[path]) return;
            if (disk.version !== current.note.version) {
              if (await desktop.confirmSaved?.(path, current.note.version, disk)) {
                const latest = sessionsRef.current[path];
                if (latest?.note.version === current.note.version && !saveFlights.current.has(path) && !recoveriesRef.current[path]) {
                  const next = { note: disk, content: latest.content, conflict: null }; putSession(next);
                  if (needsDraft(next)) await persist(next); else await queueRemoval(path);
                  resumePending(path);
                }
              } else if (needsDraft(current)) {
                const next = { ...current, conflict: "磁盘上的文件已被外部修改。当前编辑已保留，请另存或重新载入。" };
                putSession(next); cancelTimers(path); persist(next).catch(() => {});
              } else putSession({ note: disk, content: disk.content, conflict: null });
            }
          } catch (cause) {
            if (generation !== vaultGeneration.current || busyRef.current || saveFlights.current.has(path)) return;
            if (isTransient(cause)) { setError(message(cause)); return; }
            const current = sessionsRef.current[path];
            if (current?.note.version === before.note.version && !recoveriesRef.current[path]) {
              const next = { ...current, conflict: `无法读取原文件：${message(cause)}。可另存当前内容。` };
              putSession(next); cancelTimers(path); persist(next).catch(() => {});
            }
          }
        }));
      } catch (cause) { setError(`无法刷新知识库：${message(cause)}`); }
      finally { refreshBusy.current = false; }
    }, 3000);
    return () => clearInterval(interval);
  }, [vault]);

  function ask(title: string, value?: string, description?: string, choices?: Dialog["choices"]): Promise<string | null> {
    setDialogValue(value ?? "");
    return new Promise((resolve) => setDialog({ title, value, description, choices, resolve }));
  }
  function finishDialog(value: string | null) { dialog?.resolve(value); setDialog(null); }

  async function chooseVault(create: boolean) {
    if (busyRef.current) return;
    setError("");
    try {
      const path = await desktop.chooseDirectory();
      if (typeof path !== "string") return;
      const name = create ? await ask("新知识库名称", "我的知识库", "将在所选目录中创建文件夹。") : null;
      if (create && !name?.trim()) return;
      setWorking(true);
      await flushCurrent();
      vaultGeneration.current += 1;
      const status = create ? await desktop.createVault(path, name!.trim()) : await desktop.selectVault(path);
      workspaceReadyRef.current = false; setWorkspaceReady(false); workspaceKey.current = null;
      setRenaming(null); setPins([]); editorViews.current = {}; previewScrolls.current = {};canvasViews.current={};drawingViews.current={};
      setWikiChoices(null); setGraphSettings({ ...defaultGraphSettings }); setTaskSettings({ ...defaultTaskViewSettings, scrolls: {} });
      setWorkspace("notes"); setSidebarView("files"); setTaskCategory(null); setTaskGroup(null); setTaskFocus(null);
      removeDocuments([...new Set([...Object.keys(sessionsRef.current), ...Object.keys(recoveriesRef.current)])]);
      setOpenTabs([]); setActiveTabNow(null); setPaneLayout(normalizeNotePanes(null, [], null)); lastNoteTab.current = null; graphContextNote.current = null; setTaskDocument(null); setModes({}); setPreviewed([]); setPendingAnchor(undefined);
      draftErrors.current.clear(); setDraftError("");
      setCurrent(null); setSelected(""); setVault(status.vault);
      positions.clear(); setLargeInfo(null); setLargeOutline(null); setHeadingJumps({});
      const migrated = await refreshLists(true); setNotice(migrated?.moves.length ? `已整理 ${migrated.moves.length} 项目录，备份位于 ${migrated.backup}。` : "知识库已打开。");
      await restoreWorkspace(status, migrated?.moves);
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); resumePending(); setKnowledgeRevision((value) => value + 1); }
  }

  async function openNote(path: string, draft?: Draft, view: Workspace = "notes", valid?:()=>boolean) {
    if(valid&&!valid())return false;
    if (busyRef.current) return false;
    const known = [...new Set([...Object.keys(sessionsRef.current), ...Object.keys(recoveriesRef.current), ...documentsRef.current])];
    if (!draft && !known.includes(path)) {
      const matches = known.filter((entry) => entry.toLowerCase() === path.toLowerCase());
      if (matches.length === 1) path = matches[0];
    }
    if (!draft && (sessionsRef.current[path] || recoveriesRef.current[path])) { showDocument(path, view,!!valid); return true; }
    if (draft && sessionsRef.current[path] && needsDraft(sessionsRef.current[path]) && !recoveriesRef.current[path]) { setError("当前标签还有未保存编辑，请先保存或另存，再选择另一份恢复草稿。"); return false; }
    setError("");
    try {
      if(!valid)setWorking(true);
      const stored = draft ?? (await desktop.drafts()).find((item) => item.path === path);
      let disk: Note | null = null;
      try { disk = await desktop.read(path); }
      catch (cause) { if (!stored) throw cause; }
      if(valid&&!valid())return false;
      if(valid&&(sessionsRef.current[path]||recoveriesRef.current[path])){showDocument(path,view,true);return true;}
      if (disk) putSession({ note: disk, content: disk.content, conflict: null });
      setRecoveryNow(stored ? { draft: stored, disk } : null, path);
      setSelected(path); showDocument(path, view,!!valid);
      setNotice(stored ? "发现可恢复的草稿，请选择恢复或丢弃。" : (isDrawing(path)?"绘图白板已打开。":isCanvas(path)?"知识画布已打开。":"笔记已打开。"));
      return true;
    } catch (cause) { if(valid&&!valid())return false;setError(`无法打开${documentName(path)}：${message(cause)}`); return false; }
    finally { if(!valid){setWorking(false); resumePending();} }
  }
  openNoteRef.current = (path,valid)=>openNote(path,undefined,"notes",valid);

  function recoverDraft() {
    const current = recoveryRef.current;
    if (!current || discardingDraft) return;
    const { draft, disk } = current;
    desktop.selectDraft?.(draft);
    const note: Note = disk ? { ...disk, version: draft.baseVersion } : { path: draft.path, content: "", version: draft.baseVersion };
    const conflict = !disk ? "原文件不存在，请将恢复内容另存为新文件。" :
      disk.version !== draft.baseVersion ? "草稿产生后原文件已变化，请另存或重新载入。" : null;
    const next = { note, content: draft.content, conflict };
    setRecoveryNow(null); setCurrent(next); schedule(next);
    setNotice("已恢复草稿。");
  }

  async function discardDraft() {
    const current = recoveryRef.current;
    if (!current || discardingDraft) return;
    const path=current.draft.path,generation=vaultGeneration.current;
    if (await ask("丢弃恢复草稿？", undefined, "草稿内容将被删除，磁盘上的文件不受影响。") !== "confirm") return;
    if(generation!==vaultGeneration.current||recoveriesRef.current[path]!==current)return;
    setDiscardingDraft(path);setError("");
    try {
      // Refresh the retained file before deleting the recovery branch. A read
      // failure must not turn an unavailable file into an empty document.
      let disk:Note|null;
      try{disk=await desktop.read(path);}catch(cause){if(cause instanceof WorkspaceError&&cause.code==="not_found")disk=null;else throw cause;}
      if(generation!==vaultGeneration.current||recoveriesRef.current[path]!==current)return;
      desktop.selectDraft?.(current.draft);
      await queueRemoval(path);
      if(generation!==vaultGeneration.current||recoveriesRef.current[path]!==current)return;
      setRecoveryNow(null,path);
      if(disk){putSession({note:disk,content:disk.content,conflict:null});if(currentPathRef.current===path)activateDocument(path);}
      else {
        const active=activeTabRef.current,index=tabsRef.current.indexOf(path),remaining=tabsRef.current.filter(id=>id!==path);
        removeDocuments([path]);setPins(pinnedRef.current.filter(id=>id!==path));setOpenTabs(remaining);
        if(taskPathRef.current===path)setTaskDocument(null);
        setTaskCategory(category=>category===path?null:category);
        if(active===path){const neighbor=remaining[Math.max(0,Math.min(index,remaining.length-1))];if(neighbor)showTab(neighbor);else {setActiveTabNow(null);activateDocument(null);setWorkspace("notes");}}
      }
      setNotice(`已丢弃草稿：${path}。`);
    } catch (cause) { if(generation===vaultGeneration.current)setError("无法丢弃草稿："+message(cause)); }
    finally{setDiscardingDraft(null);}
  }

  async function selectEntry(entry: Entry) {
    if (busyRef.current) return;
    setSelected(entry.path);
    if (entry.isDirectory) return;
    if (isDocument(entry.path)) await openNote(entry.path);
    else if (desktop.readPdf && isPdfPath(entry.path)) previewPdf(entry.path);
    else try { await desktop.openItem(entry.path); } catch (cause) { setError(message(cause)); }
  }

  function currentFolder() {
    function find(items: Entry[]): Entry | undefined {
      for (const entry of items) {
        if (entry.issue) continue;
        if (entry.path === selected) return entry;
        const child = find(entry.children); if (child) return child;
      }
      return undefined;
    }
    const entry = find(entries);
    return entry?.isDirectory ? entry.path : parentOf(selected);
  }

  async function createCanvasFile(folder=currentFolder()){
    if(busyRef.current||!vault)return;
    let name="未命名画布.canvas",number=1;
    const used=new Set((findEntry(entries,folder)?.children??entries).map(e=>e.name.toLowerCase()));
    while(used.has(name.toLowerCase()))name="未命名画布 "+(++number)+".canvas";
    const chosen=await ask("新建知识画布",name,"位置："+(folder||"知识库根目录"));
    if(!chosen?.trim())return;
    if(/[\\/]/.test(chosen)){setError("请输入画布名称，不要包含目录分隔符");return;}
    const path=join(folder,isCanvas(chosen.trim())?chosen.trim():chosen.trim()+".canvas");
    try{
      setWorking(true);await flushCurrent();
      const note=await desktop.createNote(path,serializeCanvas(emptyCanvas()));
      putSession({note,content:note.content,conflict:null});setRecoveryNow(null,path);showTab(path);setSelected(path);
      await refreshLists();setNotice("知识画布已创建。");
    }catch(cause){setError("无法创建画布："+message(cause));}finally{setWorking(false);resumePending();}
  }

  async function createDrawingFile(folder=currentFolder()){
    if(busyRef.current||!vault)return;
    let name="未命名白板.drawing",number=1;
    const used=new Set((findEntry(entries,folder)?.children??entries).map(e=>e.name.toLowerCase()));
    while(used.has(name.toLowerCase()))name="未命名白板 "+(++number)+".drawing";
    const chosen=await ask("新建绘图白板",name,"位置："+(folder||"知识库根目录"));
    if(!chosen?.trim())return;
    if(/[\\/]/.test(chosen)){setError("请输入白板名称，不要包含目录分隔符");return;}
    const path=join(folder,isDrawing(chosen.trim())?chosen.trim():chosen.trim()+".drawing");
    try{
      setWorking(true);await flushCurrent();
      const note=await desktop.createNote(path,serializeDrawing(emptyDrawing()));
      putSession({note,content:note.content,conflict:null});setRecoveryNow(null,path);showTab(path);setSelected(path);
      await refreshLists();setNotice("绘图白板已创建。");
    }catch(cause){setError("无法创建白板："+message(cause));}finally{setWorking(false);resumePending();}
  }

  async function createItem(directory: boolean, folder = currentFolder()) {
    if (busyRef.current || !vault) return;
    const name = await ask(directory ? "新建文件夹" : "新建笔记", directory ? "新文件夹" : "未命名.md", `位置：${currentFolder() || "知识库根目录"}`);
    if (!name?.trim()) return;
    const path = join(folder, directory ? name.trim() : (isMarkdown(name.trim()) ? name.trim() : `${name.trim()}.md`));
    try {
      setWorking(true); await flushCurrent();
      if (directory) await desktop.createDirectory(path);
      else {
        const note = await desktop.createNote(path);
        putSession({ note, content: note.content, conflict: null }); setRecoveryNow(null, path); showTab(path);
      }
      setSelected(path); await refreshLists(); setNotice(directory ? "文件夹已创建。" : "笔记已创建。");
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); resumePending(); }
  }

  async function openDaily(date: string) {
    if (busyRef.current || !vault) return;
    const path = dailyPath(date);
    if (sessionsRef.current[path] || recoveriesRef.current[path]) { await openNote(path); return; }
    const stored = drafts.find((draft) => draft.path === path);
    if (stored) { await openNote(path, stored); return; }
    if (paths.includes(path)) { await openNote(path); return; }
    let ready = false;
    try {
      setWorking(true); setError("");
      await flushCurrent();
      await ensureDirectory(parentOf(path), desktop);
      try { await desktop.createNote(path); }
      catch (cause) {
        // A sync tool or another process may have created it after the scan.
        try { await desktop.read(path); } catch { throw cause; }
      }
      await refreshLists();
      ready = true;
    } catch (cause) { setError(`无法打开每日笔记：${message(cause)}`); }
    finally { setWorking(false); resumePending(); }
    if (ready) await openNote(path);
  }

  async function applyRelocation(result: Awaited<ReturnType<typeof relocateNotes>>, incomplete = false) {
    const moved = result.moves, oldPaths = result.originals.map((note) => note.path), next: Record<string, Session> = {};
    for (const [path, current] of Object.entries(sessionsRef.current)) {
      const target = remapPath(path, moved), saved = result.notes.find((note) => note.path === target);
      if (!saved) {
        next[target] = { ...current, note: { ...current.note, path: target }, content: rewriteDocumentLinks(current.content, path, target, moved, oldPaths), conflict: incomplete ? "目录调整期间原文件无法读取，当前编辑已保留，请另存恢复。" : current.conflict };
        continue;
      }
      const dirty = needsDraft(current), original = result.originals.find((note) => note.path === path);
      const changed = target !== path || saved.version !== current.note.version || rewriteDocumentLinks(current.content, path, target, moved, oldPaths) !== current.content;
      next[target] = { note: saved, content: dirty ? rewriteDocumentLinks(current.content, path, target, moved, oldPaths) : saved.content, conflict: current.conflict || (incomplete && changed ? "目录调整未完成，当前内容已保留；请检查备份中的迁移说明，再另存或重新载入。" : dirty && original?.version !== current.note.version ? "目录调整前该文件已有外部修改，请另存或重新载入。" : null) };
    }
    const restored: Record<string, Recovery> = {};
    for (const [path, recovery] of Object.entries(recoveriesRef.current)) {
      const target = remapPath(path, moved), disk = result.notes.find((note) => note.path === target) ?? recovery.disk;
      const original = result.originals.find((note) => note.path === path);
      restored[target] = { disk, draft: { ...recovery.draft, path: target, content: rewriteDocumentLinks(recovery.draft.content, path, target, moved, oldPaths), baseVersion: original?.version === recovery.draft.baseVersion && disk ? disk.version : recovery.draft.baseVersion } };
    }
    cancelTimers(); sessionsRef.current = next; setSessions(next); recoveriesRef.current = restored; setRecoveries(restored);
    for (const [path, editor] of editors.current) { const state = editor.capture(); if (state) editorViews.current[path] = state; }
    for(const [path,canvas] of canvases.current){canvasViews.current[path]=canvas.capture();if(moved.length)canvas.resetHistory();}
    for(const [path,drawing] of drawings.current){drawingViews.current[path]=drawing.capture();if(moved.length)drawing.resetHistory();}
    drawingViews.current=Object.fromEntries(Object.entries(drawingViews.current).map(([path,value])=>[remapPath(path,moved),value]));
    editorViews.current = Object.fromEntries(Object.entries(editorViews.current).map(([path, value]) => [remapPath(path, moved), value]));
    previewScrolls.current = Object.fromEntries(Object.entries(previewScrolls.current).map(([path, value]) => [remapPath(path, moved), value]));
    canvasViews.current=Object.fromEntries(Object.entries(canvasViews.current).map(([path,value])=>[remapPath(path,moved),value]));
    setPins(pinnedRef.current.map((path) => isFileTab(path) ? remapPath(path, moved) : path));
    setCollapsedFolders((previous) => previous.map((path) => remapPath(path, moved)));
    remapPanes(path => isFileTab(path) ? remapPath(path, moved) : path);
    setOpenTabs(tabsRef.current.map((id) => isFileTab(id) ? remapPath(id, moved) : id));
    const active = activeTabRef.current && (isFileTab(activeTabRef.current) ? remapPath(activeTabRef.current, moved) : activeTabRef.current); setActiveTabNow(active);
    if (lastNoteTab.current) lastNoteTab.current = remapPath(lastNoteTab.current, moved);
    if (graphContextNote.current) graphContextNote.current = remapPath(graphContextNote.current, moved);
    const current = currentPathRef.current && remapPath(currentPathRef.current, moved);
    if (taskPathRef.current) setTaskDocument(remapPath(taskPathRef.current, moved));
    if (taskCategory) { const category = remapPath(taskCategory, moved); setTaskCategory(category); setTaskGroup(taskGroupOf(category)); }
    else if (taskGroup) setTaskGroup(remapPath(taskGroup, moved));
    activateDocument(current);
    setModes((previous) => Object.fromEntries(Object.entries(previous).map(([path, value]) => [remapPath(path, moved), value])));
    setPreviewed((previous) => previous.map((path) => remapPath(path, moved)));
    setGraphSettings((previous) => ({ ...previous, center: previous.center && remapPath(previous.center, moved), folder: previous.folder ? remapPath(previous.folder, moved) : "" }));
    setTaskFocus((previous) => previous ? { ...previous, path: remapPath(previous.path, moved) } : null); setKnowledgeRevision((value) => value + 1);
    for (const entry of Object.values(next)) if (needsDraft(entry) && !restored[entry.note.path]) await persist(entry);
  }

  function jumpToHeading(heading: DocumentHeading) {
    if (!currentPath) return;
    cancelDocumentNavigation();
    if (mode !== "preview") editors.current.get(currentPath)?.reveal(heading.from,session?.content);
    setHeadingJumps((previous) => ({ ...previous, [currentPath]: { from: heading.from, serial: ++jumpSerial.current,navigation:navigationSequence.current,content:session?.content } }));
    positions.set(currentPath, { from: heading.from, line: heading.line, column: 1 });
  }
  async function copyTreeValue(path: string, kind: "relative" | "absolute" | "wiki" | "markdown" | "drawing-embed") {
    try {
      const entry = findEntry(entries, path);
      let value = path;
      if (kind === "absolute") value = web ? `${location.origin}/?note=${encodeURIComponent(path)}` : `${vault?.replace(/[\\/]+$/, "")}/${path}`.replaceAll("\\", "/").replace(/^\/\/\?\//, "");
      else if (kind === "wiki") value = `[[${wikiTargetForPath(path, pathsRef.current)}]]`;
      else if (kind === "drawing-embed") value = formatDrawingEmbed(path,drawingPaths);
      else if (kind === "markdown") {
        const current = currentPathRef.current;
        if (!current || entry?.isDirectory) throw new Error("请先打开一篇笔记，再复制相对于它的链接");
        const label = pathName(path).replace(/\.(?:md|markdown)$/i, "").replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
        value = `[${label}](${encodePath(relativePath(current, path))})`;
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error("当前环境无法访问剪贴板");
        await navigator.clipboard.writeText(value); setNotice(`已复制${kind === "drawing-embed" ? "白板嵌入语法" : kind === "wiki" || kind === "markdown" ? "笔记链接" : "路径"}。`);
      } catch { setCopyText(value); }
    } catch (cause) { setError(`复制失败：${message(cause)}`); }
  }

  async function changeItem(action: "rename" | "move" | "delete", selected = fileMenu?.path ?? "", provided?: string) {
    if (!selected || busyRef.current) return;
    const current = sessionRef.current;
    const taskFile = workspace === "tasks" && taskCategories.includes(selected);
    const taskGrouping = workspace === "tasks" && groups.includes(selected);
    const taskVersion = taskFile ? (current?.note.path === selected ? current.note.version : taskSnapshot.notes.find((note) => note.path === selected)?.version) : undefined;
    const hasEdits = () => Object.values(sessionsRef.current).some((item) => affected(item.note.path, selected) && needsDraft(item)) || Object.keys(recoveriesRef.current).some((path) => affected(path, selected));
    if (hasEdits() || drafts.some((draft) => affected(draft.path, selected))) {
      setError("请先保存或另存当前笔记，并处理待恢复草稿，再移动或删除它。"); return;
    }
    let destination = "";
    if (action === "delete") {
      if (await ask(web ? "移到应用回收站？" : "移到系统回收站？", undefined, `将删除“${selected}”；文件夹中的内容也会一并移入回收站。`) !== "confirm") return;
    } else if (action === "rename") {
      const name = selected.slice(selected.lastIndexOf("/") + 1);
      const isTaskCategory = taskFile;
      const result = provided ?? await ask(taskGrouping ? "重命名任务分组" : isTaskCategory ? "重命名任务分类" : "重命名", isTaskCategory ? categoryName(selected) : name, "将备份原文，并更新知识库中的 Markdown、Wiki 链接和附件引用。");
      if (!result?.trim()) return;
      if (/[\\/]/.test(result.trim())) { setError("重命名时请输入名称，不要包含目录路径。"); return; }
      if ((isTaskCategory || taskGrouping) && !taskCategoryBase(result)) { setError("名称无效，请使用普通名称，不要包含路径或特殊字符。"); return; }
      const targetName = isTaskCategory && !isMarkdown(result.trim()) ? `${result.trim()}.md` : result.trim();
      destination = join(parentOf(selected), targetName);
    } else {
      if (provided !== undefined) destination = provided;
      else if (taskFile) {
        const result = await ask("移动任务分类", parentOf(selected), "选择目标分组。", groups.map((path) => ({ value: path, label: pathName(path) })));
        if (!result?.trim()) return;
        destination = `${result}/${pathName(selected)}`;
      } else {
        const folder = await new Promise<string | null>((resolve) => setMovePicker({ source: selected, resolve }));
        if (folder === null) return;
        destination = join(folder, pathName(selected));
      }
    }
    if (action !== "delete" && isDocument(selected) && (isDrawing(selected)?!isDrawing(destination):isCanvas(selected)?!isCanvas(destination):!isMarkdown(destination))) {
      setError("文档名称需要保留原类型后缀（.md/.markdown、.canvas 或 .drawing）。"); return;
    }
    if (action !== "delete" && destination === selected) return true;
    try {
      setWorking(true); await flushCurrent();
      if (hasEdits()) throw new Error("文件仍有未保存编辑，请先保存或另存后再操作");
      if (taskFile) {
        const disk = await desktop.read(selected);
        if (!taskVersion || disk.version !== taskVersion || !isTaskCategoryDocument(disk.content)) throw new Error("分类文件已变化，请刷新并重新操作");
      }
      if (action !== "delete") {
        const pending = (async () => {
          try {
            const result = await relocateNotes([{ from: selected, to: destination }], desktop);
            await applyRelocation(result);
          } catch (cause) {
            if (cause instanceof RelocationError && cause.completedMoves.length) {
              const notes = await Promise.all(cause.originals.map((note) => desktop.read(remapPath(note.path, cause.completedMoves)).catch(() => null)));
              await applyRelocation({ moves: cause.completedMoves, originals: cause.originals, notes: notes.filter((note): note is Note => note !== null), backup: cause.backup }, true);
              await refreshLists();
            }
            throw cause;
          }
        })();
        organizationFlight.current = pending;
        try { await pending; }
        finally { if (organizationFlight.current === pending) organizationFlight.current = null; }
      } else {
        if (action === "delete") await desktop.remove(selected); else await desktop.move(selected, destination);
        const opened = Object.keys(sessionsRef.current).filter((path) => affected(path, selected));
        const previousTab = activeTabRef.current, previousIndex = tabsRef.current.indexOf(previousTab ?? "");
        const moved = action === "delete" ? [] : await Promise.all(opened.map(async (path) => {
          const note = await desktop.read(destination + path.slice(selected.length));
          return { note, content: note.content, conflict: null };
        }));
        setPins(pinnedRef.current.filter((path) => !isFileTab(path) || !affected(path, selected)));
        editorViews.current = Object.fromEntries(Object.entries(editorViews.current).filter(([path]) => !affected(path, selected)));
        previewScrolls.current = Object.fromEntries(Object.entries(previewScrolls.current).filter(([path]) => !affected(path, selected)));
        const nextTabs = tabsRef.current.flatMap((id) => isFileTab(id) && affected(id, selected) ? action === "delete" ? [] : [destination + id.slice(selected.length)] : [id]);
        if (action !== "delete") remapPanes(path => affected(path, selected) ? destination + path.slice(selected.length) : path);
        removeDocuments(opened); moved.forEach(putSession); setOpenTabs(nextTabs);
        setModes((previous) => Object.fromEntries(Object.entries(previous).flatMap(([path, value]) => affected(path, selected) ? action === "delete" ? [] : [[destination + path.slice(selected.length), value]] : [[path, value]])));
        if (taskPathRef.current && affected(taskPathRef.current, selected)) setTaskDocument(action === "delete" ? null : destination + taskPathRef.current.slice(selected.length));
        if (previousTab === tasksTabId) { activateDocument(taskPathRef.current); }
        else if (previousTab && isFileTab(previousTab) && affected(previousTab, selected)) {
          const next = action === "delete" ? nextTabs[Math.min(previousIndex, nextTabs.length - 1)] : destination + previousTab.slice(selected.length);
          if (next) showTab(next); else { setActiveTabNow(null); activateDocument(null); }
        }
      }
      setSelected(action === "delete" ? "" : destination);
      if (taskCategory && affected(taskCategory, selected)) setTaskCategory(action === "delete" ? null : destination + taskCategory.slice(selected.length));
      if (taskGroup && affected(taskGroup, selected)) setTaskGroup(action === "delete" ? null : destination + taskGroup.slice(selected.length));
      await refreshLists(); setNotice(action === "delete" ? web ? "已移到应用回收站，可从顶部恢复。" : "已移到系统回收站。" : "已更新路径。");
      return true;
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); resumePending(); }
  }

  async function saveAs() {
    const snapshot = sessionRef.current;
    if (!snapshot || busyRef.current) return;
    const drawing=isDrawing(snapshot.note.path),canvas=isCanvas(snapshot.note.path);
    const target = await ask(drawing?"另存为新白板":canvas?"另存为新画布":"另存为新笔记", join(parentOf(snapshot.note.path), drawing?"恢复的白板.drawing":canvas?"恢复的画布.canvas":"恢复的笔记.md"), "输入知识库内的新路径；不会覆盖已有文件。");
    if (!target?.trim()) return;
    if(isDocument(target.trim())&&(drawing?!isDrawing(target.trim()):canvas?!isCanvas(target.trim()):!isMarkdown(target.trim()))){setError("另存需要保留原文档类型");return;}
    const path = (drawing?isDrawing(target.trim()):canvas?isCanvas(target.trim()):isMarkdown(target.trim())) ? target.trim() : target.trim()+(drawing?".drawing":canvas?".canvas":".md");
    try {
      setWorking(true);
      try { await flushCurrent(); } catch { /* Continue: saving a new file can recover a draft even if draft storage failed. */ }
      const current = sessionRef.current;
      if (!current || current.note.path !== snapshot.note.path) throw new Error("当前笔记已变化，请重新操作");
      const saved = await desktop.createNote(path, rewriteDocumentLinks(current.content, current.note.path, path, [], pathsRef.current));
      if (current?.note.path === snapshot.note.path) {
        const next = { note: saved, content: rewriteDocumentLinks(sessionsRef.current[snapshot.note.path]?.content ?? current.content, current.note.path, path, [], pathsRef.current), conflict: null };
        const taskFile = !!taskGroupOf(saved.path) && isTaskCategoryDocument(saved.content);
        const previousMode = modes[snapshot.note.path] ?? "live";
        const nextTabs = tabsRef.current.map((id) => id === snapshot.note.path ? saved.path : id);
        if(isCanvas(saved.path)&&canvasViews.current[snapshot.note.path])canvasViews.current[saved.path]=canvasViews.current[snapshot.note.path];
        if(isDrawing(saved.path)&&drawingViews.current[snapshot.note.path])drawingViews.current[saved.path]=drawingViews.current[snapshot.note.path];
        remapPanes(path => path === snapshot.note.path ? saved.path : path);
        removeDocuments([snapshot.note.path]); putSession(next); setOpenTabs(nextTabs); if(isMarkdown(saved.path))setMode(previousMode, saved.path); setSelected(saved.path);
        if (taskPathRef.current === snapshot.note.path) setTaskDocument(taskFile ? saved.path : null);
        if (taskCategory === snapshot.note.path) setTaskCategory(taskFile ? saved.path : null);
        setTaskFocus(null);
        showDocument(saved.path, workspace === "tasks" && taskFile ? "tasks" : "notes");
        if (next.content !== saved.content) await persist(next);
        await queueRemoval(snapshot.note.path).catch(() => {});
        if (next.content !== saved.content) schedule(next);
      }
      await refreshLists(); setNotice("内容已另存为新文件。"); setError("");
    } catch (cause) { setError(`另存失败：${message(cause)}`); }
    finally { setWorking(false); resumePending(); }
  }

  async function reloadDisk() {
    const current = sessionRef.current;
    if (!current || busyRef.current) return;
    if (await ask("重新载入磁盘版本？", undefined, "当前未保存的编辑和恢复草稿会被丢弃。") !== "confirm") return;
    try {
      setWorking(true);
      await flushCurrent();
      const disk = await desktop.read(current.note.path);
      await queueRemoval(current.note.path);
      cancelTimers(current.note.path); setCurrent({ note: disk, content: disk.content, conflict: null });
      setSaveErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([path])=>path!==current.note.path)));
      setNotice("已载入磁盘版本。"); setError("");
    } catch (cause) { setError(`无法载入：${message(cause)}`); }
    finally { setWorking(false); resumePending(); }
  }

  async function importFile() {
    const current = sessionRef.current;
    if (!current || current.conflict || busyRef.current || recoveryRef.current) return;
    if(isDrawing(current.note.path)){setError("绘图白板首版不支持图片导入，请使用画布或笔记附件。");return;}
    if(isCanvas(current.note.path)){canvases.current.get(current.note.path)?.chooseImages();return;}
    try {
      const source = await desktop.chooseFile();
      if (typeof source !== "string") return;
      setWorking(true);
      const relative = await desktop.importAttachment(current.note.path, source);
      const snippet = attachmentMarkdown(relative);
      const latest = sessionRef.current;
      if (latest && latest.note.path === current.note.path) {
        const editor = workspace === "notes" ? editors.current.get(current.note.path) : null;
        if (editor) editor.insert(snippet);
        else changeContent(`${latest.content}${latest.content && !latest.content.endsWith("\n") ? "\n" : ""}${snippet}\n`);
      }
      await refreshLists(); setNotice("附件已复制到笔记所在目录的 attachments 文件夹。");
    } catch (cause) { setError(`导入附件失败：${message(cause)}`); }
    finally { setWorking(false); }
  }

  function focusTask(path: string, from: number, id?: string) {
    setTaskFocus({ path, from, id, serial: ++taskFocusSerial.current });
  }

  function editTask(item: TaskItemView, action: TaskAction): string | null {
    const current = sessionsRef.current[item.path];
    try {
      if (busyRef.current || recoveriesRef.current[item.path] || !current || current.conflict || (current.note.version !== item.version && current.content !== item.content) || !isTaskCategoryDocument(current.content)) throw new Error("任务文件已变化或正在处理，请重新选择任务");
      const { task } = item;
      if (action.kind === "startDate" || action.kind === "endDate") {
        const latest = parseTaskDocument(current.content).tasks.find((entry) => entry.from === task.from);
        if (latest?.[action.kind] === action.value) return current.content;
      }
      const content = action.kind === "delete" ? removeTask(current.content, task) : changeManagedTask(current.content, task, action);
      changeContent(content, item.path);
      return content;
    } catch (cause) { setError(`无法修改任务：${message(cause)}`); return null; }
  }

  async function saveTaskBeforeLeaving(path: string): Promise<boolean> {
    const current = sessionRef.current;
    if (current && current.note.path !== path && !!taskGroupOf(current.note.path) && isTaskCategoryDocument(current.content) && needsDraft(current)) {
      if (current.conflict || recoveryRef.current) { setError("请先处理当前任务分类的冲突或恢复草稿。"); return false; }
      await saveCurrent();
      const latest = sessionRef.current;
      if (latest?.note.path === current.note.path && needsDraft(latest)) { setNotice("当前分类尚未保存，请先处理保存问题。"); return false; }
    }
    return true;
  }

  async function openTaskCategory(path: string): Promise<boolean> {
    return await saveTaskBeforeLeaving(path) && await openNote(path, undefined, "tasks");
  }

  async function selectTask(item: TaskItemView, toggle = false) {
    if (busyRef.current) return;
    if (sessionRef.current?.note.path !== item.path || recoveryRef.current) {
      if (!await openTaskCategory(item.path)) return;
    }
    if (recoveryRef.current) { setTaskCategory(item.path); setNotice("请先处理该分类的恢复草稿。"); return; }
    const current = sessionRef.current;
    if (!current || (current.note.version !== item.version && current.content !== item.content) || current.content.slice(item.task.from, item.task.to) !== item.task.raw) {
      setError("任务文件已变化，请在更新后的列表中重新选择。"); return;
    }
    if (toggle) editTask(item, { kind: "completed", value: !item.task.completed });
    else focusTask(item.path, item.task.from, item.task.id);
  }

  async function placeBoardTask(item: TaskItemView, status: TaskStatus, before?: TaskItemView | null): Promise<boolean> {
    const generation = vaultGeneration.current;
    const scope = () => JSON.stringify([workspaceSnapshot.current.taskCategory, workspaceSnapshot.current.taskGroup, workspaceSnapshot.current.tasks.query, workspaceSnapshot.current.tasks.filter]);
    const originalScope = scope();
    try {
      if (busyRef.current) return false;
      if (currentPathRef.current !== item.path || recoveryRef.current) {
        if (!await openTaskCategory(item.path)) return false;
      }
      const current = sessionsRef.current[item.path];
      if (generation !== vaultGeneration.current || activeTabRef.current !== tasksTabId || scope() !== originalScope) throw new Error("工作区或任务范围已变化，请重试");
      if (!current || recoveriesRef.current[item.path] || current.conflict || !isTaskCategoryDocument(current.content) || current.content !== item.content) throw new Error("任务内容已变化或有待处理草稿，请重新选择");
      if (before !== undefined && (taskCategory !== item.path || taskSettings.query.trim() || taskSettings.filter !== "all")) throw new Error("请进入单分类并清除筛选后排序");
      if (before && (before.path !== item.path || before.content !== item.content)) throw new Error("排序目标已变化");
      const content = before === undefined ? changeManagedTask(current.content, item.task, { kind: "status", value: status }) : placeTask(current.content, item.task, status, before?.task.from ?? null);
      changeContent(content, item.path);
      return true;
    } catch (cause) { setError("无法调整任务：" + message(cause)); return false; }
  }

  async function promptTaskGroup() {
    if (busyRef.current || !vault) return;
    const raw = await ask("新建任务分组", "新分组", "分组对应“任务”目录下的文件夹。");
    if (!raw?.trim()) return;
    const name = taskCategoryBase(raw);
    if (!name) { setError("分组名称无效，请使用普通文件夹名称。"); return; }
    const path = `${taskFolder}/${name}`;
    try {
      setWorking(true); await flushCurrent();
      await ensureDirectory(taskFolder, desktop);
      if (findEntry(await desktop.entries(), path)) throw new Error("同名分组或文件已存在");
      await desktop.createDirectory(path);
      setTaskGroup(path); setTaskCategory(null); setTaskFocus(null); showTab(tasksTabId);
      await refreshLists(); setNotice(`分组“${name}”已创建。`);
    } catch (cause) { setError(`无法创建分组：${message(cause)}`); }
    finally { setWorking(false); resumePending(); }
  }

  async function createTaskCategory(rawName: string, group = taskGroup ?? defaultTaskGroup): Promise<string | null> {
    if (recoveryRef.current) { setError("请先处理当前待恢复的草稿。"); return null; }
    const name = taskCategoryBase(rawName);
    if (!name || !/^任务\/[^/]+$/.test(group)) { setError("分类或分组名称无效，请使用普通文件名。"); return null; }
    const path = `${group}/${name}.md`;
    if (!await saveTaskBeforeLeaving(path)) return null;
    try {
      setWorking(true); setError(""); await flushCurrent();
      if ((await desktop.drafts()).some((draft) => draft.path === path)) throw new Error("该分类有待恢复草稿，请先处理草稿");
      await ensureDirectory(group, desktop);
      if (findEntry(await desktop.entries(), group)?.children.some((entry) => entry.path.toLowerCase() === path.toLowerCase())) throw new Error(`“${path}”已存在，请使用其他分类名称，原文件不会被覆盖`);
      const note = await desktop.createNote(path, `${taskCategoryMarker}\n\n# ${name}\n\n`);
      setCurrent({ note, content: note.content, conflict: null }); setRecoveryNow(null);
      setSelected(path); setTaskCategory(path); setTaskGroup(group); setTaskFocus(null); showDocument(path, "tasks");
      await refreshLists(); setNotice(`分类“${name}”已创建。`);
      return path;
    } catch (cause) { setError(`无法创建任务分类：${message(cause)}`); return null; }
    finally { setWorking(false); resumePending(); }
  }

  async function promptTaskCategory(group = taskGroup ?? defaultTaskGroup) {
    if (busyRef.current || !vault) return;
    const name = await ask("新建任务分类", "新分类", `分组：${pathName(group)}，一个分类对应一个 Markdown 文件。`);
    if (name?.trim()) await createTaskCategory(name, group);
  }

  async function addTask(title: string, status: TaskStatus = "todo"): Promise<boolean> {
    if (busyRef.current || !vault) return false;
    const fromAll = taskCategory === null;
    const previousGroup = taskGroup, group = taskGroup ?? defaultTaskGroup;
    let path = taskCategory;
    if (!path) {
      path = taskCategories.find((entry) => entry === `${group}/收件箱.md`) ?? null;
      if (!path) path = await createTaskCategory("收件箱", group);
      else {
        if (!await openTaskCategory(path)) return false;
      }
      if (!path) return false;
    }
    const current = sessionRef.current;
    if (!current || current.note.path !== path || recoveryRef.current || current.conflict || busyRef.current || !isTaskCategoryDocument(current.content)) {
      setError("请先打开分类并处理草稿或文件冲突。"); return false;
    }
    try {
      const added = appendManagedTask(current.content, title, status);
      changeContent(added.content); setTaskFocus(null);
      if (fromAll) { setTaskCategory(null); setTaskGroup(previousGroup); }
      return true;
    } catch (cause) { setError(`无法添加任务：${message(cause)}`); return false; }
  }

  async function deleteTask(item: TaskItemView) {
    if (await ask("删除任务？", undefined, `将从“${categoryName(item.path)}”删除“${item.task.title}”及其备注。`) !== "confirm") return;
    if (editTask(item, { kind: "delete" }) !== null) setTaskFocus(null);
  }

  async function moveTask(item: TaskItemView, target: string) {
    if (busyRef.current || !taskCategories.includes(target) || target === item.path) return;
    let copied = false;
    try {
      let current = sessionRef.current;
      if (!current || current.note.path !== item.path || current.note.version !== item.version || current.conflict || recoveryRef.current || !isTaskCategoryDocument(current.content)) throw new Error("任务文件已变化，请重新选择任务");
      if (!taskWritable(item.task)) throw new Error("任务字段需处理，请先检查原文件");
      const expectedTask = item.task;
      const issue = taskMoveIssue(current.content, expectedTask);
      if (issue) throw new Error(issue);
      if (needsDraft(current)) await saveCurrent();
      current = sessionRef.current;
      if (!current || current.note.path !== item.path || current.conflict || needsDraft(current)) throw new Error("请先保存来源分类并处理冲突");
      const task = parseTaskDocument(current.content).tasks.find((entry) => (expectedTask.id ? entry.id === expectedTask.id : entry.from === expectedTask.from) && entry.raw === expectedTask.raw);
      if (!task) throw new Error("来源任务已变化，请重新选择");
      setWorking(true);
      await saveCurrent(target, true);
      const cachedTarget = sessionsRef.current[target];
      if (recoveriesRef.current[target] || cachedTarget?.conflict || (cachedTarget && needsDraft(cachedTarget))) throw new Error("目标分类在其他标签中仍有未保存编辑、恢复草稿或冲突，请先处理");
      if ((await desktop.drafts()).some((draft) => draft.path === target)) throw new Error("目标分类有待恢复草稿，请先处理草稿");
      const destination = await desktop.read(target);
      if (!isTaskCategoryDocument(destination.content)) throw new Error("目标文件不再是任务分类，请刷新后重试");
      if (expectedTask.id && parseTaskDocument(destination.content).tasks.some((entry) => entry.id === expectedTask.id)) throw new Error("目标分类存在相同任务ID，请先处理");
      let destinationContent = appendExistingTask(destination.content, current.content, task, (text) => rewriteDocumentLinks(text, item.path, target, [], pathsRef.current));
      const addedTask = parseTaskDocument(destinationContent).tasks.at(-1)!;
      destinationContent = placeTask(destinationContent, addedTask, addedTask.status!);
      const copiedNote = await desktop.save(target, destinationContent, destination.version);
      copied = true;
      if (sessionsRef.current[target] !== cachedTarget && sessionsRef.current[target] && needsDraft(sessionsRef.current[target])) {
        const latest = { ...sessionsRef.current[target], conflict: "任务移动期间该分类又有编辑，已保留，请处理磁盘上的新增任务副本。" };
        putSession(latest); persist(latest).catch(() => {});
        throw new Error("目标标签出现新编辑，来源任务仍然保留");
      }
      putSession({ note: copiedNote, content: copiedNote.content, conflict: null });
      const remaining = removeTask(current.content, task);
      const saved = await desktop.save(current.note.path, remaining, current.note.version);
      setCurrent({ note: saved, content: saved.content, conflict: null });
      await queueRemoval(saved.path).catch(() => {});
      setKnowledgeRevision((value) => value + 1); setTaskFocus(null);
      setNotice(`任务已移动到“${categoryName(target)}”。`);
    } catch (cause) {
      setError(copied ? `目标分类已写入，但来源分类未能确认移除：${message(cause)}。请检查两个分类，避免重复。` : `无法移动任务：${message(cause)}`);
      setKnowledgeRevision((value) => value + 1);
    } finally { setWorking(false); resumePending(); }
  }

  async function openTaskSource(path: string) {
    if (await openNote(path)) { setMode("source"); setSidebarView("files"); setSidebarCollapsed(false); }
  }

  async function closeTab(id: string) { await closeTabs([id]); }
  async function closeTabs(ids: string[]) {
    if (busyRef.current) return;
    const targets = ids.filter((id) => tabsRef.current.includes(id) && !pinnedRef.current.includes(id));
    if (!targets.length) return;
    const protectedPaths = [...new Set([...targets.filter(isFileTab), ...(targets.includes(tasksTabId) ? [...Object.keys(sessionsRef.current), ...Object.keys(recoveriesRef.current)].filter((path) => !!taskGroupOf(path)) : [])])];
    try {
      setWorking(true); setError("");
      for (const path of protectedPaths) {
        await flushDocumentImports(path);
        await saveCurrent(path, true);
        await flushPath(path);
        if (sessionsRef.current[path] && needsDraft(sessionsRef.current[path]) && !recoveriesRef.current[path]) {
          if (!targets.includes(path) && targets.includes(tasksTabId)) { setTaskDocument(path); showTab(tasksTabId); }
          else showTab(path);
          throw new Error(`“${path}”尚未保存，请先处理冲突或另存；草稿与标签均已保留`);
        }
      }
      // No tab is removed until every target has passed save and draft checks.
      const wasRight = panesRef.current.right.includes(activeTabRef.current ?? "");
      const group = tabsRef.current.filter(path => panesRef.current.right.includes(path) === wasRight);
      const index = group.indexOf(activeTabRef.current ?? ""), next = tabsRef.current.filter((tab) => !targets.includes(tab));
      const groupRemaining = group.filter(path => !targets.includes(path));
      for (const path of protectedPaths) { const state = editors.current.get(path)?.capture(); if (state) editorViews.current[path] = state; }
      setOpenTabs(next);
      if (targets.includes(tasksTabId)) { setTaskDocument(null); setTaskCategory(null); setTaskGroup(null); setTaskFocus(null); }
      removeDocuments(protectedPaths.filter((path) => !next.includes(path) && !(next.includes(tasksTabId) && taskPathRef.current === path)));
      if (activeTabRef.current && targets.includes(activeTabRef.current)) {
        const neighbor = groupRemaining[Math.min(index, groupRemaining.length - 1)] ?? next[0];
        if (neighbor) showTab(neighbor);
        else { setActiveTabNow(null); activateDocument(null); setWorkspace("notes"); if (sidebarView === "tasks") setSidebarView("files"); }
      }
    } catch (cause) { setError(`无法关闭标签：${message(cause)}`); }
    finally { setWorking(false); resumePending(); }
  }

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing || busyRef.current || widgetDrawer || dialog || wikiChoices || movePicker || imagePreview || pdfPreview || exportJob || batchPicker || batchExport || slides || historyJob || webdavOpen || renaming || copyText!==null) return;
      if (workspace === "graph" && event.key.toLowerCase() === "s") { event.preventDefault(); setNotice("图谱根据已保存笔记生成，无需单独保存。"); return; }
      if (event.key.toLowerCase() === "p" && !settingsOpen && vault) { event.preventDefault(); const next = event.shiftKey ? "commands" : "files"; setPalette((previous) => previous === next ? null : next); return; }
      if (event.key === ",") { event.preventDefault(); setSettingsOpen((previous) => !previous); return; }
      if (settingsOpen || palette || !tabsRef.current.length) return;
      if (event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); if(event.shiftKey)void saveAsRef.current();else void saveRef.current(currentPathRef.current??"");return; }
      if (event.shiftKey && event.key.toLowerCase() === "o" && workspace === "notes" && isMarkdown(currentPathRef.current??"")) { event.preventDefault(); toggleOutline(); }
      else if (event.key.toLowerCase() === "w") { event.preventDefault(); if (activeTabRef.current) void closeTab(activeTabRef.current); }
      else if (event.key === "Tab") {
        event.preventDefault();
        const right = panesRef.current.right.includes(activeTabRef.current ?? "");
        const all = tabsRef.current.filter(path => panesRef.current.right.includes(path) === right), index = all.indexOf(activeTabRef.current ?? "");
        if (!all.length) return;
        showTab(all[(index + (event.shiftKey ? -1 : 1) + all.length) % all.length]);
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [tabs, activeTab, dialog, wikiChoices, sidebarView, taskCandidates, workspace, settingsOpen, widgetDrawer, movePicker, narrow, mobileOutline, outlineOpen, palette, imagePreview, pdfPreview, vault, exportJob, batchPicker, batchExport, slides, historyJob, webdavOpen, renaming, copyText]);

  async function syncWebDav(config:WebDavConfig,resolutions:SyncResolution[]) {
    if(busyRef.current||webdavFlight.current)throw new Error("已有文件操作或同步正在进行，请稍后重试。");
    const generation=vaultGeneration.current;webdavFlight.current=true;setWebdavRunning(true);
    try{
      await flushCurrent();resumePending();
      const drafts=await desktop.drafts();
      if(generation!==vaultGeneration.current)throw new Error("知识库已切换，请在当前知识库重新同步。");
      const protectedPaths=[...new Set([...drafts.map(d=>d.path),...Object.values(sessionsRef.current).filter(s=>needsDraft(s)||recoveriesRef.current[s.note.path]||editors.current.get(s.note.path)?.hasPendingImports()||canvases.current.get(s.note.path)?.hasPendingImports()).map(s=>s.note.path),...Object.keys(recoveriesRef.current)])];
      const result=await desktop.webdavSync!({config,protectedPaths,resolutions});
      if(generation!==vaultGeneration.current)return result;
      await refreshLists();
      for(const path of result.changed){
        if(generation!==vaultGeneration.current)break;
        if(!sessionsRef.current[path]||recoveriesRef.current[path])continue;
        await saveFlights.current.get(path);
        const before=sessionsRef.current[path];if(!before||recoveriesRef.current[path])continue;
        let disk:Note;
        try{
          disk=await desktop.read(path);
        }catch(cause){
          if(generation!==vaultGeneration.current)break;
          const current=sessionsRef.current[path];if(current&&current.note.version===before.note.version&&!saveFlights.current.has(path)&&!recoveriesRef.current[path]){const next={...current,conflict:"同步后无法读取原文件，当前内容已保留："+message(cause)};putSession(next);cancelTimers(path);await persist(next);}continue;
        }
        if(generation!==vaultGeneration.current)break;
        const current=sessionsRef.current[path];
        if(!current||current.note.version!==before.note.version||saveFlights.current.has(path)||recoveriesRef.current[path]||current.note.version===disk.version)continue;
        if(needsDraft(current)||editors.current.get(path)?.hasPendingImports()||canvases.current.get(path)?.hasPendingImports()){
          const next={...current,conflict:"WebDAV 已更新磁盘；同步期间的新编辑和撤销记录仍保留，请另存或处理外部修改。"};putSession(next);cancelTimers(path);await persist(next);
        }else putSession({note:disk,content:disk.content,conflict:null});
      }
      if(generation===vaultGeneration.current){setKnowledgeRevision(v=>v+1);setNotice(`WebDAV：上传 ${result.uploaded}、下载 ${result.downloaded}，${result.conflicts.length} 个冲突、${result.skipped.length} 个跳过、${result.errors.length} 个未完成。`);}
      return result;
    }finally{webdavFlight.current=false;setWebdavRunning(false);resumePending();}
  }

  function beginHistory(path=activeTabRef.current) {
    if(!path||!isMarkdown(path)||!sessionsRef.current[path]||busyRef.current||!desktop.fileHistory||!desktop.readHistory||!desktop.checkpointHistory)return;
    cancelDocumentNavigation();setHistoryJob({path,generation:vaultGeneration.current});
  }
  function closeHistory() {
    if(historyFlight.current)return;
    const path=historyJob?.path;setHistoryJob(null);
    requestAnimationFrame(()=>{
      if(path&&activeTabRef.current===path&&sessionsRef.current[path]){
        if((modes[path]??preferencesRef.current.defaultMode)!=="preview")editors.current.get(path)?.focus();
        else document.getElementById(panelId(path)+"-header")?.querySelector<HTMLElement>(".note-more summary")?.focus();
      }
    });
  }
  useEffect(()=>{
    if(historyJob&&(historyJob.generation!==vaultGeneration.current||activeTab!==historyJob.path||!sessions[historyJob.path]||busy&&!historyFlight.current))setHistoryJob(null);
  },[activeTab,sessions,busy,vault,historyJob]);
  async function restoreHistory(snapshot:HistorySnapshot,expected:string) {
    const job=historyJob;
    if(!job||historyFlight.current||busyRef.current)return;
    const {path,generation}=job;
    function source() {
      const current=sessionsRef.current[path];
      if(generation!==vaultGeneration.current||activeTabRef.current!==path||!current||current.content!==expected||recoveriesRef.current[path]||current.conflict)
        throw new Error("笔记内容或草稿状态已变化，请重新检查差异后再还原。");
      return current;
    }
    source();historyFlight.current=true;setHistoryRestoring(true);setWorking(true);cancelTimers(path);
    let applied=false;
    try {
      await flushDocumentImports(path);
      await saveFlights.current.get(path);cancelTimers(path);
      const current=source();
      // Draft and durable checkpoints must both succeed before changing the editor.
      await persist(current);
      await desktop.checkpointHistory!(path,current.content,current.note.version);
      source();
      if(!editors.current.get(path)?.restoreSnapshot?.(snapshot.content,expected))throw new Error("编辑器正在输入或内容已变化，请结束输入后重试。");
      applied=true;
      await persist(sessionsRef.current[path]);
      setHistoryJob(null);setNotice("已还原到编辑器，将按设置自动保存；Ctrl+Z 可撤销还原。");
      requestAnimationFrame(()=>{if(activeTabRef.current===path&&(modes[path]??preferencesRef.current.defaultMode)!=="preview")editors.current.get(path)?.focus();});
    } catch(cause) {
      if(applied)throw new Error("内容已还原，原内容已有保护快照，但还原后的草稿写入失败："+message(cause));
      throw cause;
    } finally {historyFlight.current=false;setHistoryRestoring(false);setWorking(false);resumePending();}
  }

  async function beginExport(path=activeTabRef.current) {
    if(!path||!isMarkdown(path)||!sessionsRef.current[path]||recoveriesRef.current[path]||busyRef.current)return;
    const generation=vaultGeneration.current,serial=++exportSerial.current;
    setExportJob({path,generation,snapshot:null,error:""});
    try {
      await flushDocumentImports(path);
      if(serial!==exportSerial.current||generation!==vaultGeneration.current||activeTabRef.current!==path||busyRef.current)return;
      const latest=sessionsRef.current[path];
      if(!latest||recoveriesRef.current[path])throw new Error("来源笔记或草稿状态已变化，请重新打开导出");
      setExportJob({path,generation,error:"",snapshot:{path,content:latest.content,unsaved:needsDraft(latest),conflict:!!latest.conflict,paths:[...pathsRef.current],drawingPaths:documentsRef.current.filter(isDrawing),capturedAt:Date.now()}});
    } catch(cause){if(serial===exportSerial.current)setExportJob({path,generation,snapshot:null,error:message(cause)});}
  }
  function closeExport(){
    const path=exportJob?.path;
    ++exportSerial.current;setExportJob(null);
    requestAnimationFrame(()=>{
      if(document.activeElement?.closest('[aria-modal="true"]'))return;
      if(path&&path===activeTabRef.current&&sessionsRef.current[path]){
        if(modes[path]!=="preview")editors.current.get(path)?.focus();
        else document.getElementById(panelId(path) + "-header")?.querySelector<HTMLElement>(".note-more summary")?.focus();
      }
    });
  }

  async function exportCanvas(path: string, format: GraphicFormat) {
    if (busyRef.current || recoveriesRef.current[path]) return;
    const generation = vaultGeneration.current;
    setWorking(true);
    try {
      await flushDocumentImports(path);
      const current = sessionsRef.current[path];
      if (!current || generation !== vaultGeneration.current) return;
      const { knowledgeRaster, saveGraphic } = await import("../lib/graphic-export");
      const canvas = await knowledgeRaster(current.content, path, desktop);
      if (generation === vaultGeneration.current) setNotice(await saveGraphic(runtime, canvas, path, format));
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(false); resumePending(); }
  }

  async function applySearchReplacement(items:Replacement[]) {
    if(busyRef.current)throw new Error("请等待当前文件操作完成");
    setWorking(true);
    const generation=vaultGeneration.current;
    const skipped:string[]=[];
    let saved=0;
    try{
      const drafts=new Set((await desktop.drafts()).map(draft=>draft.path));
      for(const {note,content} of items){
        const path=note.path, current=sessionsRef.current[path];
        if(generation!==vaultGeneration.current)throw new Error("知识库已经切换");
        if(!isMarkdown(path)||drafts.has(path)||recoveriesRef.current[path]||saveFlights.current.has(path)||
          editors.current.get(path)?.hasPendingImports()||current&&(needsDraft(current)||current.conflict||current.note.version!==note.version)){
          skipped.push(path+" · 内容或草稿已变化");continue;
        }
        try{
          const updated=await desktop.save(path,content,note.version);
          saved++;
          if(sessionsRef.current[path]===current&&current)putSession({note:updated,content:updated.content,conflict:null});
        }catch(cause){skipped.push(path+" · "+message(cause));}
      }
    }finally{
      if(saved)setKnowledgeRevision(value=>value+1);
      setWorking(false);resumePending();
    }
    return {saved,skipped};
  }

  async function captureExportSource(path:string,generation:number):Promise<ExportSnapshot>{
    await flushDocumentImports(path);
    if(generation!==vaultGeneration.current)throw new Error("知识库已经切换");
    if(recoveriesRef.current[path])throw new Error("请先确认 "+path+" 的恢复草稿");
    const current=sessionsRef.current[path],note=current?.note??await desktop.read(path);
    if(generation!==vaultGeneration.current)throw new Error("知识库已经切换");
    return {path,content:current?.content??note.content,unsaved:!!current&&needsDraft(current),conflict:!!current?.conflict,
      paths:[...pathsRef.current],drawingPaths:documentsRef.current.filter(isDrawing),capturedAt:Date.now()};
  }

  async function beginBatchExport(selected:string[]){
    if(busyRef.current)return;
    setBatchPicker(false);
    const generation=vaultGeneration.current,serial=++batchSerial.current;
    setBatchExport({paths:selected,error:""});
    try{
      const snapshots:ExportSnapshot[]=[];
      for(const path of selected){
        if(serial!==batchSerial.current)return;
        snapshots.push(await captureExportSource(path,generation));
      }
      if(serial===batchSerial.current)setBatchExport({paths:selected,snapshots,error:""});
    }catch(cause){if(serial===batchSerial.current)setBatchExport({paths:selected,error:message(cause)});}
  }

  async function beginSlides(path:string){
    if(busyRef.current)return;
    try{
      const snapshot=await captureExportSource(path,vaultGeneration.current);
      if(activeTabRef.current===path)setSlides(snapshot);
    }catch(cause){setError(message(cause));}
  }

  async function exportVaultZip(){
    if(busyRef.current||!vault)return;
    if(web){
      const link=document.createElement("a");
      link.href="/api/export/vault";link.download="noto-vault.zip";
      document.body.append(link);link.click();link.remove();
      setNotice("正在生成知识库 ZIP，请查看浏览器下载状态。");
      return;
    }
    if(!runtime.saveVaultZip)return;
    setWorking(true);
    try{
      const destination=await runtime.saveVaultZip();
      setNotice(destination?"知识库 ZIP 已保存 "+destination:"已取消导出 ZIP");
    }catch(cause){setError(message(cause));}
    finally{setWorking(false);resumePending();}
  }
  useEffect(()=>{
    if(exportJob&&(exportJob.generation!==vaultGeneration.current||activeTab!==exportJob.path||!sessions[exportJob.path]||busy)){
      ++exportSerial.current;setExportJob(null);
    }
  },[activeTab,sessions,busy,vault,exportJob]);

  const canExportNote = !busy && workspace === "notes" && !!session && isMarkdown(session.note.path) && !recovery;
  const canBatchExport = !busy && !!vault && paths.length >= 2;
  const canExportVault = !busy && !!vault && (web || !!runtime.saveVaultZip);
  const commands = [
    { id: "quick", label: "快速打开文档", detail: "笔记、知识画布和绘图白板", keys: "Ctrl+P", run: () => setPalette("files") },
    { id: "sidebar", label: "显示或隐藏侧栏", run: toggleSidebar },
    { id: "search", label: "搜索全部笔记", run: () => { setSidebarView("search"); setSidebarCollapsed(false); if (narrow) setMobileSidebar(true); } },
    { id: "tags", label: "浏览标签", disabled: !vault, run: () => { if (sidebarView !== "tags" || !showSidebar) togglePanel("tags"); } },
    ...(preferences.showNoteHeatmap ? [{ id: "heatmap", label: "打开笔记热力图", disabled: !vault, run: () => setWidgetDrawer("heatmap") }] : []),
    ...(preferences.showNoteDashboard ? [{ id: "dashboard", label: "打开仪表盘", disabled: !vault, run: () => setWidgetDrawer("dashboard") }] : []),
    {id:"batch-export",label:"多篇合并导出",disabled:!canBatchExport,run:()=>setBatchPicker(true)},
    {id:"vault-zip",label:"导出整库 ZIP（已保存文件）",disabled:!canExportVault,run:()=>{void exportVaultZip();}},
    {id:"slides",label:"播放 Markdown 幻灯片",disabled:!currentPath||!isMarkdown(currentPath)||!!recovery,run:()=>{if(currentPath)void beginSlides(currentPath);}},
    {id:"new-canvas",label:"新建知识画布",run:()=>{void createCanvasFile();}},
    {id:"new-drawing",label:"新建绘图白板",run:()=>{void createDrawingFile();}},
    {id:"drawing-svg",label:"导出白板 SVG 快照",detail:drawingActive&&session?documentSaveIssue(session.note.path,session.content)||"导出当前编辑快照，不改变保存状态":"请先打开绘图白板",disabled:!drawingActive||!!recovery||!!session&&!!documentSaveIssue(session.note.path,session.content),run:()=>{const path=currentPath;requestAnimationFrame(()=>{if(path&&activeTabRef.current===path)void drawings.current.get(path)?.exportSvg();});}},
    { id: "new-note", label: "新建笔记", run: () => { void createItem(false); } },
    { id: "new-folder", label: "新建文件夹", run: () => { void createItem(true); } },
    { id: "tasks", label: "打开任务管理", run: () => showTab(tasksTabId) },
    { id: "graph", label: "打开全库知识图谱", run: () => openGraph("global") },
    { id: "local-graph", label: "打开当前笔记局部图谱", disabled: !lastNoteTab.current, run: () => openGraph("local") },
    { id: "daily", label: "打开今日日记", run: () => { void openDaily(localDate(new Date())); } },
    { id:"export",label:"导出当前笔记（HTML / PDF）",disabled:!canExportNote,run:()=>{void beginExport();} },
    { id:"file-history",label:"文件恢复：查看近期快照",disabled:workspace!=="notes"||!session||!isMarkdown(session.note.path)||!desktop.fileHistory,run:()=>beginHistory() },
    { id: "save", label: "保存当前文档", detail: saveFeedback({present:!!session,recovery:!!recovery,conflict:session?.conflict,issue:session?documentSaveIssue(session.note.path,session.content):"",saving,dirty:!!session&&needsDraft(session),failure:currentPath?saveErrors[currentPath]:undefined}).label, keys: "Ctrl+S", disabled: !session || saving || !needsDraft(session) || !!recovery || !!session.conflict || !!documentSaveIssue(session.note.path,session.content), run: () => { void saveCurrent(); } },
    ...([['live', '实时编辑'], ['source', '源码视图'], ['preview', '阅读视图'], ['split', '编辑与预览分屏']] as const).map(([id, label]) => ({ id, label, disabled: workspace !== "notes" || !session || structuredActive, run: () => setMode(id) })),
    { id: "reveal", label: "在文件树中定位当前文档", disabled: !session, run: () => { if (session) revealInTree(session.note.path); } },
    {id:"copy-heading",label:"复制当前标题 Wiki 链接",disabled:workspace!=="notes"||structuredActive||!session||!!recovery||!info.headings.length,run:()=>{const heading=info.headings.filter(item=>item.from<=(positions.get(currentPath??"")?.from??0)).at(-1)??info.headings[0];if(heading)void copyHeading(heading);}},
    {id:"copy-block",label:"复制当前块 Wiki 链接",detail:"首次复制会在笔记中插入块标记",disabled:workspace!=="notes"||structuredActive||!session||!!recovery,run:()=>{void copyBlock();}},
    { id: "outline", label: "显示或隐藏标题大纲", keys: "Ctrl+Shift+O", disabled: workspace !== "notes" || !session || structuredActive, run: toggleOutline },
    { id: "theme", label: "切换深浅主题", run: toggleTheme },
    { id: "settings", label: "软件设置", keys: "Ctrl+,", run: () => setSettingsOpen(true) },
    { id:"webdav",label:"WebDAV 同步",disabled:!vault||!desktop.webdavSync,run:()=>setWebdavOpen(true) },
  ];
  const paletteFiles: PaletteItem[] = [...new Set([...tabs.filter(isFileTab), ...documents])].map((path) => ({ id: path, label: pathName(path), detail: documentName(path)+" · "+path }));

  const dirtyTabs = [...Object.values(sessions).filter(needsDraft).map(current => current.note.path), ...(Object.values(sessions).some(current => !!taskGroupOf(current.note.path) && isTaskCategoryDocument(current.content) && needsDraft(current)) ? [tasksTabId] : [])];
  const conflictTabs = [...Object.values(sessions).filter(current => !!current.conflict).map(current => current.note.path), ...Object.keys(recoveries), ...(Object.values(sessions).some(current => !!taskGroupOf(current.note.path) && isTaskCategoryDocument(current.content) && current.conflict) || Object.keys(recoveries).some(path => !!taskGroupOf(path)) ? [tasksTabId] : [])];
  function renderTabStrip(right: boolean) {
    return <div className={`note-tab-strip ${right === panes.right.includes(activeTab ?? "") ? "focused" : ""}`} onDragOver={dragTabOver} onDrop={event => dropTab(event, right)}>
      <WorkspaceTabs tabs={right ? panes.right : leftTabs} active={right ? panes.rightActive : panes.leftActive} label={right ? "右侧笔记标签" : dualPane ? "左侧笔记标签" : "工作区标签"} dragScope={canvasScope} onTabDrag={path => { draggedTab.current = path; }} pinned={pinned} busy={busy} dirty={dirtyTabs} conflicts={conflictTabs} onPin={togglePin} onReorder={(from, to) => setOpenTabs(reorderTabs(tabsRef.current, from, to, pinnedRef.current))} onCloseTabs={ids => { void closeTabs(ids); }} onReveal={revealInTree} onSelect={id => showTab(id)} onClose={id => { void closeTab(id); }} onMovePane={path => moveTabToPane(path, !right)} moveLabel={right ? "移到左侧" : "在右侧打开"} />
      {right ? <button type="button" className="pane-toggle" disabled={busy} aria-label="合并到左侧" title="合并到左侧，保留所有笔记" onClick={mergePanes}><WorkspaceIcon name="close" size={14}/></button> : !dualPane && <button type="button" className="pane-toggle" disabled={busy || !tabs.some(isMarkdown)} aria-label="在右侧打开当前笔记" title="在右侧打开当前笔记，也可拖入笔记标签" onDragOver={dragTabOver} onDrop={event => dropTab(event, true)} onClick={() => { const path = isMarkdown(activeTab ?? "") ? activeTab : tabs.find(isMarkdown); if (path) void openOnRight(path); }}><WorkspaceIcon name="sidebar" size={15}/></button>}
    </div>;
  }
  function renderDocumentHeader(path: string | null, right: boolean) {
    const column = right ? 3 : 1;
    if (!path || !isFileTab(path) || !sessions[path]) return dualPane ? <div className="note-header note-header-placeholder" style={{ gridColumn: column }}>{path === graphTabId ? "知识图谱" : path === tasksTabId ? "任务管理" : path || "左侧笔记"}</div> : null;
    const current = sessions[path], restored = !!recoveries[path], structured = isStructuredDocument(path), drawing = isDrawing(path), pending = needsDraft(current);
    const issue = documentSaveIssue(path, current.content), saving = savingPaths.includes(path);
    const feedback = saveFeedback({ present: true, recovery: restored, conflict: current.conflict, issue, saving, dirty: pending, failure: saveErrors[path] });
    function run(action: () => unknown, button?: HTMLElement) {
      button?.closest("details")?.removeAttribute("open");
      focusVisibleTab(path!); action();
    }
    return <div className="note-header" id={panelId(path) + "-header"} role="group" aria-label={`文档工具栏 ${path}`} data-note-pane={right ? "right" : "left"} style={{ gridColumn: column }} onPointerDownCapture={() => focusVisibleTab(path)} onFocusCapture={() => focusVisibleTab(path)}>
      <div className="document-title"><strong title={path}>{dualPane ? pathName(path) : path}</strong><span className={"save-status " + feedback.state} role="status" title={feedback.detail}>{feedback.label}</span></div>
      <div className="note-actions"><details className="note-more"><summary aria-label={dualPane ? `${path}的文档更多操作` : "文档更多操作"} title="文档更多操作"><WorkspaceIcon name="more" size={18}/></summary><div>
        {!structured && <button type="button" disabled={busy || restored} onClick={event => run(() => { void beginExport(path); }, event.currentTarget)}>导出（HTML / PDF）</button>}
        {!structured && <button type="button" disabled={busy || restored} onClick={event => run(() => { void beginSlides(path); }, event.currentTarget)}>播放 Markdown 幻灯片</button>}
        {!structured && paths.length>=2 && <button type="button" disabled={busy} onClick={event=>run(()=>setBatchPicker(true),event.currentTarget)}>多篇合并导出</button>}
        {!structured && desktop.fileHistory && <button type="button" disabled={busy} onClick={event=>run(()=>beginHistory(path),event.currentTarget)}>文件恢复</button>}
        {drawing && <button type="button" disabled={busy || restored || !!issue} onClick={event => run(() => { void drawings.current.get(path)?.exportSvg(); }, event.currentTarget)}>导出白板 SVG 快照</button>}
        {structured && (["png", "pdf"] as const).map(format => <button type="button" key={format} disabled={busy || restored || !!issue} onClick={event => run(() => {
          if (drawing) void drawings.current.get(path)?.exportGraphic(format);
          else void exportCanvas(path, format);
        }, event.currentTarget)}>导出{drawing ? "白板" : "知识画布"} {format.toUpperCase()}</button>)}
        {dualPane && !structured && <button type="button" disabled={busy || restored || !!current.conflict} onClick={event => run(() => { void importFile(); }, event.currentTarget)}>导入附件</button>}
        {dualPane && <button type="button" disabled={busy || restored} onClick={event => run(() => { void saveAs(); }, event.currentTarget)}>另存为</button>}
        <button type="button" disabled={busy} onClick={event => run(() => revealInTree(path), event.currentTarget)}>在文件树中定位</button>
      </div></details>
        {!dualPane && <><button type="button" disabled={busy || restored || !!current.conflict} hidden={structured} onClick={() => run(() => { void importFile(); })}>导入附件</button><button type="button" disabled={busy || restored} onClick={() => run(() => { void saveAs(); })}>另存为</button></>}
        <button type="button" className={dualPane ? "pane-save" : "primary"} aria-label={dualPane ? `保存 ${path}` : undefined} title={`保存 ${path}（Ctrl+S）`} disabled={busy || saving || restored || !!current.conflict || !pending || !!issue} onClick={() => run(() => { void saveCurrent(path); })}>{dualPane ? <WorkspaceIcon name="save" size={16}/> : "保存"}</button>
      </div>
    </div>;
  }
  const documentInputBlocked = !!(settingsOpen || widgetDrawer || dialog || renaming || movePicker || fileMenu || wikiChoices || palette || historyJob || webdavOpen || imagePreview || pdfPreview || exportJob || batchPicker || batchExport || copyText !== null);
  return <main className={`desktop-app theme-${theme}`} data-theme-id={preferences.themeId} data-editor-font={preferences.font} style={{ ...themeVariables(preferences.themeId), "--sidebar-width": `${sidebarWidth}px`, "--outline-width": `${outlineWidth}px`, "--editor-font": fontFamilies[preferences.font], "--editor-font-size": `${preferences.fontSize}px`, "--editor-line-height": preferences.lineHeight, "--content-width": preferences.contentWidth ? `${preferences.contentWidth}px` : "100%", "--split-ratio": splitRatio } as CSSProperties}>
    <header className="titlebar">
      <div className="titlebar-controls">
        <div className="titlebar-section">
          <div className="brand-name"><img className="brand-mark" src="/noto-mark.svg" width="24" height="24" alt="" /><strong>Noto</strong></div>
          <span className="titlebar-divider" />
          <VaultSwitcher vault={vault} web={web} busy={busy} onOpen={() => { void chooseVault(false); }} onCreate={() => { void chooseVault(true); }} />
          {web && <><button type="button" className="titlebar-btn labeled" disabled={busy} onClick={async () => { try { setTrashItems(await desktop.trash!()); } catch (cause) { setError(message(cause)); } }}>回收站</button><button type="button" className="titlebar-btn labeled" disabled={busy} onClick={async () => { try { await flushCurrent(); await runtime.logout?.(); } catch (cause) { setError(message(cause)); } }}>退出登录</button></>}
        </div>
        <button type="button" className="titlebar-path quick-open-trigger" aria-label="快速打开笔记" disabled={!vault || busy} onClick={() => setPalette("files")} title={workspace === "graph" ? "知识图谱" : workspace === "tasks" ? (taskCategory || "任务管理") : session?.note.path || vault || ""}>{workspace === "graph" ? "知识图谱" : workspace === "tasks" ? (taskCategory || "任务管理") : session?.note.path || (vault ? vault.replace(/^\\\\\?\\/, "") : "本地知识库")}</button>
        {session && workspace === "notes" && !structuredActive && <div className="editor-view-controls"><div className="view-toggle" role="group" aria-label="编辑视图">
          <button type="button" aria-pressed={mode === "live"} className={mode === "live" ? "vt-active" : ""} onClick={() => setMode("live")}>实时编辑</button>
          <button type="button" aria-pressed={mode === "preview"} className={mode === "preview" ? "vt-active" : ""} onClick={() => setMode("preview")}>阅读</button>
          <button type="button" aria-pressed={mode === "source"} className={mode === "source" ? "vt-active" : ""} onClick={() => setMode("source")}>源码</button>
          <button type="button" aria-pressed={mode === "split"} className={mode === "split" ? "vt-active" : ""} onClick={() => setMode("split")}>分屏</button>
        </div><button type="button" className="outline-toggle" aria-label={showOutline ? "隐藏标题大纲" : "显示标题大纲"} title="标题大纲（Ctrl+Shift+O）" aria-pressed={showOutline} onClick={toggleOutline}><WorkspaceIcon name="outline" size={16}/></button></div>}
        {(preferences.showNoteHeatmap || preferences.showNoteDashboard) && <div className="titlebar-widgets" role="group" aria-label="小组件">
          {(["heatmap", "dashboard"] as const).filter(id => id === "heatmap" ? preferences.showNoteHeatmap : preferences.showNoteDashboard).map(id =>
            <button key={id} type="button" className="titlebar-btn" disabled={!vault || busy} title={widgetTitles[id]} aria-label={widgetTitles[id]} aria-expanded={widgetDrawer === id}
              aria-controls={widgetDrawer === id ? "widget-drawer" : undefined} onClick={() => { setFileMenu(null); setWidgetDrawer(previous => previous === id ? null : id); }}><WorkspaceIcon name={id} size={18}/></button>)}
        </div>}
      </div>
    </header>
    {(error || draftError) && <div className="error-banner" role="alert">{error && <div>{error}</div>}{draftError && <div>{draftError}</div>}<button type="button" onClick={() => { setError(""); setDraftError(""); }}>关闭提示</button></div>}
    <div className={`app-body ${narrow ? "narrow-layout" : ""}`}>
      <nav className="activity-bar" aria-label="主要工具栏">
        <button type="button" className="activity-sidebar-toggle" onClick={toggleSidebar} title={showSidebar ? "隐藏侧栏" : "显示侧栏"} aria-label="显示或隐藏侧栏" aria-pressed={showSidebar} aria-controls={showSidebar ? "workspace-sidebar" : undefined}><WorkspaceIcon name="sidebar" size={20}/></button>
        <button type="button" className={showSidebar && sidebarView === "files" ? "activity-active" : ""} onClick={() => togglePanel("files")} title="文件树" aria-label="文件树" aria-pressed={showSidebar && sidebarView === "files"}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></button>
        <button type="button" disabled={!vault} className={showSidebar && sidebarView === "search" ? "activity-active" : ""} onClick={() => togglePanel("search")} title="搜索" aria-label="搜索" aria-pressed={showSidebar && sidebarView === "search"}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></button>
        <button type="button" disabled={!vault} className={showSidebar && sidebarView === "tags" ? "activity-active" : ""} onClick={() => togglePanel("tags")} title="标签索引" aria-label="标签索引" aria-pressed={showSidebar && sidebarView === "tags"}><WorkspaceIcon name="tag" size={20}/></button>
        <button type="button" disabled={!vault} className={workspace === "tasks" ? "activity-active" : ""} onClick={() => togglePanel("tasks")} title="任务管理" aria-label="任务管理" aria-pressed={workspace === "tasks"}><WorkspaceIcon name="checklist" size={20}/></button>
        <button type="button" disabled={!vault} className={showSidebar && sidebarView === "calendar" ? "activity-active" : ""} onClick={() => togglePanel("calendar")} title="日历" aria-label="日历" aria-pressed={showSidebar && sidebarView === "calendar"}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M7 14h3m3 0h3m-9 4h3"/></svg></button>
        <button type="button" disabled={!session||structuredActive} className={showSidebar && sidebarView === "backlinks" ? "activity-active" : ""} onClick={() => togglePanel("backlinks")} title="反向链接" aria-label="反向链接" aria-pressed={showSidebar && sidebarView === "backlinks"}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 7H7a4 4 0 0 0 0 8h3m4-8h3a4 4 0 0 1 0 8h-3M8 11h8m-3 6-3 3-3-3"/></svg></button>
        <button type="button" disabled={!vault || busy} className={workspace === "graph" ? "activity-active" : ""} aria-label="知识图谱" title="知识图谱" aria-pressed={workspace === "graph"} onClick={() => openGraph()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="m10 8-4 7m8-7 4 7M8 18h8"/></svg></button>
        <button type="button" className="activity-theme" onClick={toggleTheme} title={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"} aria-label={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}><WorkspaceIcon name={theme === "dark" ? "sun" : "moon"} size={20}/></button>
        <button type="button" aria-label="命令面板" title="命令面板（Ctrl+Shift+P）" disabled={!vault || busy} onClick={() => setPalette("commands")}><WorkspaceIcon name="command" size={20}/></button>
        <button type="button" className={settingsOpen ? "activity-active" : ""} onClick={() => setSettingsOpen(true)} title="软件设置（Ctrl+,）" aria-label="软件设置" aria-pressed={settingsOpen}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m9 3-.7 2.6-2.6.7L3.8 8l1.3 2.3v3.4L3.8 16l1.9 1.7 2.6.7L9 21h6l.7-2.6 2.6-.7 1.9-1.7-1.3-2.3v-3.4L20.2 8l-1.9-1.7-2.6-.7L15 3z"/><circle cx="12" cy="12" r="3.2"/></svg></button>
      </nav>
      {narrow && (showSidebar || mobileOutline) && <button type="button" className="panel-scrim" aria-label="收起侧面板" onClick={() => { setMobileSidebar(false); setMobileOutline(false); if (!preferences.autoCollapseSidebar) setSidebarCollapsed(true); }} />}
      {showSidebar && <aside className="sidebar" id="workspace-sidebar" aria-label="工作区侧栏">
        {sidebarView === "files" && <>
        <div className="sidebar-heading">
          <strong title={vault || ""}>{vault ? vault.replace(/^\\\\\?\\/, "").split(/[\\/]/).filter(Boolean).pop() : "文件"}</strong>
          <div className="sidebar-tools">
            <button type="button" disabled={!vault || busy} onClick={() => createItem(false)} title={`新建笔记（${currentFolder() || "根目录"}）`} aria-label="新建笔记"><WorkspaceIcon name="new-file"/></button>
            <button type="button" disabled={!vault || busy} onClick={() => createItem(true)} title={`新建文件夹（${currentFolder() || "根目录"}）`} aria-label="新建文件夹"><WorkspaceIcon name="new-folder"/></button>
            <button type="button" disabled={!vault || busy || !selected} onClick={() => setSelected("")} title="返回根目录" aria-label="返回根目录"><WorkspaceIcon name="home"/></button>
            <button type="button" disabled={!vault || busy} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); event.stopPropagation(); setFileMenu({ path: selected, x: rect.left, y: rect.bottom }); }} title="所选文件的操作" aria-label="所选文件的操作" aria-expanded={!!fileMenu}><WorkspaceIcon name="more"/></button>
          </div>
        </div>
        <div className="tree-scroll"><FileTree dragScope={canvasScope} entries={entries} selected={selected} collapsed={collapsedFolders} onCollapse={(path, value) => setCollapsedFolders((previous) => value ? [...new Set([...previous, path])] : previous.filter((item) => item !== path))} managedFoldersExpanded={managedFoldersExpanded} onManagedFoldersExpanded={setManagedFoldersExpanded} busy={busy} renaming={renaming} onBeginRename={beginRename} onCancelRename={() => setRenaming(null)} onRename={async (path, name) => !!await changeItem("rename", path, name)} onMove={(from, folder) => { void changeItem("move", from, join(folder, pathName(from))); }} select={(entry) => { void selectEntry(entry); }} context={(path, x, y) => { setSelected(path); setFileMenu({ path, x, y }); }} /></div>
        {drafts.length > 0 && <div className="draft-list"><strong>可恢复草稿</strong>{drafts.map((draft, index) => <button type="button" key={draft.recoveryId ?? draft.path} disabled={busy} title={draft.recoveryId ? "不同网页标签的草稿分别保留" : undefined} onClick={() => openNote(draft.path, draft)}>{draft.path}{drafts.filter((item) => item.path === draft.path).length > 1 ? ` · 草稿 ${index + 1}` : ""}</button>)}</div>}
        </>}
        {sidebarView === "search" && <SearchPanel key={canvasScope} analysis={searchAnalysis} paths={paths} attachmentPaths={attachmentPaths} snapshot={knowledge} onChoose={chooseSearch} onContext={onSearchContext} onReplace={applySearchReplacement} local={searchLocal} onGlobal={()=>setSearchLocal(null)} onClose={() => setSidebarView("files")} />}
        {sidebarView === "tags" && <TagPanel key={canvasScope} snapshot={knowledge} current={currentPath} busy={busy} onOpen={path=>{openLinkedNote(path);if(narrow)setMobileSidebar(false);}} onClose={() => setSidebarView("files")} />}
        {sidebarView === "backlinks" && (session&&isMarkdown(session.note.path) ? <BacklinksPanel snapshot={{...knowledge, loading:relatedLoading, errors:relatedErrors}} target={session.note.path} paths={paths} relations={relations} onWikiOpen={openWiki} onOpen={openReference} onClose={() => setSidebarView("files")} /> : <p className="knowledge-empty">反向链接用于 Markdown 笔记，请先打开一篇笔记。</p>)}
        {sidebarView === "calendar" && <CalendarPanel paths={paths} current={session?.note.path} busy={busy} onDate={(date) => { void openDaily(date); }} onClose={() => setSidebarView("files")} />}
        {sidebarView === "tasks" && <TaskSidebar paths={taskCategories} groups={groups} group={taskGroup} category={taskCategory} busy={busy || !!recovery} onAll={() => { setTaskCategory(null); setTaskGroup(null); setTaskFocus(null); }} onGroup={(path) => { setTaskGroup(path); setTaskCategory(null); setTaskFocus(null); }} onCategory={(path) => { void openTaskCategory(path).then((opened) => { if (opened) { setTaskCategory(path); setTaskGroup(parentOf(path)); setTaskFocus(null); } }); }} onCreate={(group) => { void promptTaskCategory(group); }} onCreateGroup={() => { void promptTaskGroup(); }} onContext={(path, x, y) => { setSelected(path); setFileMenu({ path, x, y }); }} />}
      </aside>}
      <ResizeHandle label="侧栏宽度" value={sidebarWidth} min={180} max={520} onChange={setSidebarWidth} reset={250} hidden={!showSidebar || narrow} />
      <section className="main-pane" ref={mainPane} style={{ "--note-pane-ratio": panes.ratio } as CSSProperties}>
        <div className={`note-tab-groups ${dualPane ? "dual" : ""}`}>
          {renderTabStrip(false)}{dualPane && <><div className="tab-group-divider" />{renderTabStrip(true)}</>}
        </div>
        {searchStale&&activeTab===searchStale.path&&<div className="search-feedback" role="status"><span>搜索结果已过期，无法唯一确认原命中。</span><button type="button" onClick={()=>searchCurrentContent(searchStale.path)}>在当前内容中查找</button></div>}
        {searchMark&&activeTab===searchMark.path&&(mode==="preview"||mode==="split")&&searchPreviewStatus&&searchPreviewStatus!=="exact"&&<div className="search-feedback" role="status"><span>{searchPreviewStatus==="source"?"已定位所属块；命中位于 Markdown 源码。":"命中仅在源码中可确认，阅读位置未移动。"}</span><button type="button" onClick={searchInSource}>在源码中查看</button></div>}

        {recovery && <div className="recovery-banner"><strong>发现恢复草稿：{recovery.draft.path}</strong><p>{recovery.disk ? "可恢复未保存的编辑，或保留磁盘版本。" : "原文件已不存在，仍可恢复草稿并另存。"}</p><div><button type="button" className="primary" disabled={busy||!!discardingDraft} onClick={recoverDraft}>恢复草稿</button><button type="button" disabled={busy||!!discardingDraft} onClick={discardDraft}>{discardingDraft===recovery.draft.path?"正在丢弃…":"丢弃草稿"}</button></div></div>}
        {workspace === "tasks" && session?.conflict && <div className="conflict-banner" role="alert"><span>{session.conflict}</span><button type="button" disabled={busy} onClick={saveAs}>另存为</button><button type="button" disabled={busy} onClick={reloadDisk}>重新载入</button></div>}

        {workspace === "notes" && session?.conflict && <div className="conflict-banner" role="alert"><span>{session.conflict}</span><button type="button" disabled={busy} onClick={saveAs}>另存为</button><button type="button" disabled={busy} onClick={reloadDisk}>重新载入</button></div>}
        <div className={`workspace-deck ${dualPane ? "dual" : ""}`} onDragOverCapture={dragTabOver} onDropCapture={event => { const target = event.target as HTMLElement; dropTab(event, target.closest("[data-note-pane]")?.getAttribute("data-note-pane") === "right"); }}>
          {renderDocumentHeader(panes.leftActive, false)}
          {dualPane && renderDocumentHeader(panes.rightActive, true)}
        {tabs.includes(graphTabId) && <div className="workspace-panel graph-panel" role="tabpanel" id={panelId(graphTabId)} aria-labelledby={panelId(graphTabId) + "-tab"} hidden={!visibleTab(graphTabId)} style={!visibleTab(graphTabId) ? { display: "none" } : undefined} onPointerDownCapture={() => { focusVisibleTab(graphTabId); }} onFocusCapture={() => { focusVisibleTab(graphTabId); }}>
          <KnowledgeGraphView key={vault} graph={graph} settings={graphSettings} currentNote={graphContextNote.current && tabs.includes(graphContextNote.current) ? graphContextNote.current : null} onChange={(patch) => setGraphSettings((previous) => ({ ...previous, ...patch }))} onOpen={openReference} active={visibleTab(graphTabId)} loading={relatedLoading} errors={relatedErrors} issues={recentRelations?.answer?.issues ?? []} theme={preferences.themeId} />
        </div>}
        {tabs.includes(tasksTabId) && <div className="workspace-panel" role="tabpanel" id={panelId(tasksTabId)} aria-labelledby={`${panelId(tasksTabId)}-tab`} hidden={!visibleTab(tasksTabId)} style={!visibleTab(tasksTabId) ? { display: "none" } : undefined} onPointerDownCapture={() => { focusVisibleTab(tasksTabId); }} onFocusCapture={() => { focusVisibleTab(tasksTabId); }}>
          <TaskWorkspace active={visibleTab(tasksTabId)} settings={taskSettings} onSettings={(patch) => setTaskSettings((previous) => ({ ...previous, ...(typeof patch === "function" ? patch(previous) : patch) }))} onPlace={placeBoardTask} group={taskGroup} category={taskCategory} categories={taskCategories} snapshot={taskSnapshot} session={taskSession} recovery={!!taskRecovery} dirty={!!taskSession && needsDraft(taskSession)} busy={busy} saving={!!taskPath && savingPaths.includes(taskPath)} saveError={taskPath?saveErrors[taskPath]:undefined} focus={taskFocus} paths={paths} draftPaths={drafts.map((draft) => draft.path)} onAdd={addTask} onSelect={(item, toggle) => { void selectTask(item, toggle); }} onEdit={editTask} onDelete={(item) => { void deleteTask(item); }} onMove={(item, target) => { void moveTask(item, target); }} onSource={(path) => { void openTaskSource(path); }} onSave={() => { void saveCurrent(taskPath); }} onError={setError} onOpenNote={openLinkedNote} onWikiOpen={openWiki} wikiServices={wikiServices} />
        </div>}
        {!panes.leftActive && <div className="empty-state" onPointerDownCapture={() => { if (dualPane) { setActiveTabNow(null); activateDocument(null); setWorkspace("notes"); } }}>{vault ? <><h1>打开文档，开始记录</h1><p>笔记、知识画布和绘图白板都保存在知识库中。</p><div className="empty-actions" role="group" aria-label="新建文档"><button type="button" aria-label="创建笔记" disabled={busy} onClick={()=>{void createItem(false);}}>新建笔记</button><button type="button" aria-label="创建知识画布" disabled={busy} onClick={()=>{void createCanvasFile();}}>新建知识画布</button><button type="button" aria-label="创建绘图白板" disabled={busy} onClick={()=>{void createDrawingFile();}}>新建绘图白板</button></div><button type="button" className="empty-open" disabled={busy} onClick={()=>setPalette("files")}>快速打开文档 <kbd>Ctrl+P</kbd></button></> : <div className="setup-card"><img className="setup-mark" src="/noto-mark.svg" width="42" height="42" alt="" /><h1>创建你的知识空间</h1><p>知识库是存放 Markdown 文件和附件的本地文件夹。</p><button type="button" className="setup-option" onClick={() => chooseVault(true)}><span>＋</span><div><strong>创建新知识库</strong><small>在本机新建一个文件夹</small></div></button><button type="button" className="setup-option" onClick={() => chooseVault(false)}><span>▱</span><div><strong>打开现有知识库</strong><small>选择已有的笔记文件夹</small></div></button></div>}</div>}
          {dualPane && <ResizeHandle label="左右笔记宽度" value={panes.ratio} min={.25} max={.75} step={.05} scale={() => Math.max(1, (mainPane.current?.clientWidth ?? 805) - 5)} onChange={ratio => setPaneLayout({ ...panesRef.current, ratio })} reset={.5} />}
        {tabs.filter(isCanvas).map(path=>{
          const current=sessions[path],visible=visibleTab(path);
          return <div key={path} role="tabpanel" className="workspace-panel canvas-panel" id={panelId(path)} aria-labelledby={panelId(path)+"-tab"} hidden={!visible} style={!visible?{display:"none"}:undefined} onPointerDownCapture={() => focusVisibleTab(path)} onFocusCapture={() => focusVisibleTab(path)}>
            {current&&<KnowledgeCanvas key={canvasScope+"|"+path} ref={handle=>{if(handle)canvases.current.set(path,handle);else canvases.current.delete(path);}} path={path} value={current.content}
              active={visible && !documentInputBlocked}
              disabled={busy||!!recoveries[path]} entries={entries} scope={canvasScope} revision={knowledgeRevision} initialState={canvasViews.current[path]}
              onChange={value=>changeContent(value,path)} onError={setError} onOpen={openLinkedNote} onWikiOpen={openWiki} wikiServices={wikiServices}
              onViewChange={state=>{canvasViews.current[path]=state;scheduleWorkspace();}}
              onImportState={pending=>setImportingPaths(previous=>pending?[...new Set([...previous,path])]:previous.filter(p=>p!==path))}
              onImported={relative=>{setNotice("图片已导入："+relative);const generation=vaultGeneration.current;void desktop.entries().then(files=>{if(generation===vaultGeneration.current)setEntries(files);}).catch(cause=>setError(message(cause)));}}/>}
          </div>;
        })}
        {tabs.filter(isDrawing).map(path=>{
          const current=sessions[path],visible=visibleTab(path);
          return <div key={path} role="tabpanel" className="workspace-panel drawing-panel" id={panelId(path)} aria-labelledby={panelId(path)+"-tab"} hidden={!visible} style={!visible?{display:"none"}:undefined} onPointerDownCapture={() => focusVisibleTab(path)} onFocusCapture={() => focusVisibleTab(path)}>
            {current&&<DrawingWhiteboard key={canvasScope+"|"+path} ref={handle=>{if(handle)drawings.current.set(path,handle);else drawings.current.delete(path);}} path={path} value={current.content}
              active={visible && !documentInputBlocked}
              disabled={busy||!!recoveries[path]} entries={entries} scope={canvasScope} initialState={drawingViews.current[path]}
              onChange={value=>changeContent(value,path)} onError={setError} onOpen={openLinkedNote}
              onViewChange={state=>{drawingViews.current[path]=state;scheduleWorkspace();}}/>}
          </div>;
        })}
        {tabs.filter(isMarkdown).map((path) => {
          const current = sessions[path], visible = visibleTab(path), large = largeNotes.has(path);
          const viewMode = modes[path] ?? preferences.defaultMode;
          const previewVisible = viewMode === "split" || viewMode === "preview";
          if (!current) return <div key={path} role="tabpanel" id={panelId(path)} aria-labelledby={`${panelId(path)}-tab`} hidden={!visible} data-note-pane={panes.right.includes(path) ? "right" : "left"} style={{ display: visible ? undefined : "none", gridColumn: panes.right.includes(path) ? 3 : 1 }} onPointerDownCapture={() => focusVisibleTab(path)} onFocusCapture={() => focusVisibleTab(path)} />;
          return <div className={`editor-area note-panel ${viewMode}`} role="tabpanel" key={path} id={panelId(path)} aria-labelledby={`${panelId(path)}-tab`} hidden={!visible} data-note-pane={panes.right.includes(path) ? "right" : "left"} data-focused={activeTab === path} onPointerDownCapture={() => { focusVisibleTab(path); }} onFocusCapture={() => { focusVisibleTab(path); }} style={!visible ? { display: "none" } : { gridColumn: panes.right.includes(path) ? 3 : 1 }}>
            <div className="editor-mount" hidden={viewMode === "preview"} style={viewMode === "preview" ? { display: "none" } : undefined}>
              <MarkdownEditor large={large} drawingPaths={drawingPaths} onOpenNote={openLinkedNote} onCopyBlock={()=>{void copyBlock();}} embedScope={canvasScope} embedRevision={knowledgeRevision} ref={(handle) => { if (handle) editors.current.set(path, handle); else editors.current.delete(path); }} value={current.content} notePath={path} disabled={busy || !!recoveries[path]} live={viewMode === "live"} focused={activeTab === path} isFocusCurrent={() => activeTabRef.current === path} active={visible && viewMode !== "preview" && !documentInputBlocked} onError={setError} onImportStateChange={(pending) => setImportingPaths((previous) => pending ? [...new Set([...previous, path])] : previous.filter((item) => item !== path))} onImported={(relative) => { const generation = vaultGeneration.current; setNotice(`附件已保存：${relative}`); void desktop.entries().then((files) => { if (generation === vaultGeneration.current && !busyRef.current) setEntries(files); }).catch((cause) => setError(message(cause))); }} initialState={editorViews.current[path]} onViewStateChange={(state) => { editorViews.current[path] = state; scheduleWorkspace(); }} wikiPaths={paths} searchHighlight={visible&&viewMode!=="preview"&&searchMark?.path===path?searchMark:undefined} onSearchClear={clearSearchHighlight} onReady={markEditorReady} onWikiOpen={openWiki} wikiServices={wikiServices} onPositionChange={(position) => positions.set(path, position)} onDocumentInfo={(content, info) => { if (activeTabRef.current === path && sessionsRef.current[path]?.content === content) setLargeInfo({path, content, info}); }} onChange={(value) => changeContent(value, path)} onSave={() => { void saveCurrent(path); }} onSaveAs={() => { void saveAs(); }} onImport={() => { void importFile(); }} />
            </div>
            <ResizeHandle label="编辑与预览比例" value={splitRatio} min={.25} max={.75} step={.05} scale={() => document.getElementById(panelId(path))?.clientWidth ?? 800} onChange={setSplitRatio} reset={.5} hidden={viewMode !== "split"} />
            <div className="preview-mount" hidden={viewMode !== "split" && viewMode !== "preview"} style={viewMode !== "split" && viewMode !== "preview" ? { display: "none" } : undefined}>
              {(large ? visible && previewVisible : previewed.includes(path) || previewVisible) && <MarkdownPreview onCheckboxChange={value=>{if(!busyRef.current&&sessionsRef.current[path]?.content===current.content){focusVisibleTab(path);changeContent(value,path);}}} checkboxesDisabled={busy||!!recoveries[path]} drawingPaths={drawingPaths} onCopyBlock={(kind,from,content)=>{void copyPreviewBlock(path,kind,from,content);}} embedScope={canvasScope} embedRevision={knowledgeRevision} embedActive={visible&&(viewMode === "preview"||viewMode === "split")} initialScroll={previewScrolls.current[path]} onScrollChange={(scroll) => { previewScrolls.current[path] = scroll; scheduleWorkspace(); }} headingJump={visible ? headingJumps[path] : undefined} onHeadingHandled={serial=>setHeadingJumps(previous=>{if(previous[path]?.serial!==serial)return previous;const next={...previous};delete next[path];return next;})} searchHighlight={visible&&searchMark?.path===path?searchMark:undefined} onSearchClear={clearSearchHighlight} isSearchCurrent={serial=>searchMarkRef.current?.serial===serial&&navigationSequence.current===serial&&activeTabRef.current===path&&sessionsRef.current[path]?.content===searchMarkRef.current.content} isHeadingCurrent={serial=>{const job=headingJumps[path];return job?.serial===serial&&activeTabRef.current===path&&(job.navigation===undefined||job.navigation===navigationSequence.current)&&(job.content===undefined||job.content===sessionsRef.current[path]?.content);}} onSearchLocated={(serial,status)=>{if(searchMarkRef.current?.serial===serial&&activeTabRef.current===path){setSearchPreviewStatus(status);if(status!=="exact")setNotice(status==="source"?"已定位所属块，命中位于 Markdown 源码。":"阅读中无法精确映射，请在源码中查看。");}}} note={path} content={current.content} onError={setError} anchor={visible ? pendingAnchor : undefined} isAnchorCurrent={()=>activeTabRef.current===path&&pendingAnchorNavigation.current===navigationSequence.current} onAnchorHandled={clearPendingAnchor} onOpenNote={openLinkedNote} wikiPaths={paths} onWikiOpen={openWiki} wikiServices={wikiServices} />}
            </div>
          </div>;
        })}
        </div>
      </section>
      {workspace === "notes" && session && showOutline && <><ResizeHandle label="标题大纲宽度" value={outlineWidth} min={180} max={420} reverse onChange={setOutlineWidth} reset={220} hidden={narrow} /><OutlinePanel key={session.note.path} onCopy={heading=>{void copyHeading(heading);}} headings={info.headings} positions={positions} path={session.note.path} pending={largeNote && info.words === null} paged={largeNote} onJump={jumpToHeading} onClose={() => { if (largeNote) setLargeOutline(null); else if (narrow) setMobileOutline(false); else setOutlineOpen(false); }} /></>}
      {widgetDrawer && <WidgetDrawer id="widget-drawer" title={widgetTitles[widgetDrawer]} wide={widgetDrawer === "heatmap"} onClose={() => setWidgetDrawer(null)}>
        {widgetDrawer === "heatmap"
          ? <NoteHeatmap key={canvasScope} revision={knowledgeRevision} />
          : <DashboardPanel analysis={dashboardAnalysis} vault={vault} paths={paths} revision={knowledgeRevision} generation={vaultGeneration} busy={busy} onOpen={path => { setWidgetDrawer(null); openLinkedNote(path); }} />}
      </WidgetDrawer>}
    </div>
    <footer className="status-bar"><span className="status-notice" role="status" title={notice}>{busy ? "正在处理…" : saving ? "正在自动保存…" : webdavRunning ? "WebDAV 正在后台同步…" : importingPaths.length ? "正在导入附件，请等待完成…" : notice}</span>{workspace === "notes" && session && !structuredActive && <div className="document-stats" aria-label="笔记统计">{info.words !== null && <span title="中文每个汉字计一字，其他语言按连续词统计；不计 Markdown 格式标记和链接地址">{info.words.toLocaleString()} 字</span>}<span title="Markdown 原文的 Unicode 字符数，包含空白和格式标记">{info.characters.toLocaleString()} 字符</span><span>{info.lines.toLocaleString()} 行</span>{mode !== "preview" && <CursorPosition positions={positions} path={session.note.path} />}</div>}{workspace === "graph" && <span className="document-stats">{graph.nodes.length} 篇笔记 · {graph.edges.length} 条笔记关系 · 基于已保存内容</span>}{workspace === "tasks" && <span className="document-stats">{groups.length} 个分组 · {taskCategories.length} 个分类 · {taskSnapshot.notes.filter((note) => taskCategories.includes(note.path)).reduce((sum, note) => sum + parseTaskDocument(note.content).tasks.length, 0)} 项任务</span>}</footer>
    {exportJob && <ExportDialog snapshot={exportJob.snapshot} error={exportJob.error} presets={preferences.exportPresets} defaultPreset={preferences.defaultExportPreset} onClose={closeExport} onRefresh={()=>{void beginExport(exportJob.path);}}/>}
    {batchPicker && <BatchExportPicker paths={paths} current={currentPath} onConfirm={selected=>{void beginBatchExport(selected);}} onClose={()=>setBatchPicker(false)}/>}
    {batchExport && <ExportDialog snapshot={null} batch={batchExport.snapshots} error={batchExport.error} presets={preferences.exportPresets} defaultPreset={preferences.defaultExportPreset} onClose={()=>{++batchSerial.current;setBatchExport(null);}} onRefresh={()=>{void beginBatchExport(batchExport.paths);}}/>}
    {slides && <SlideViewer snapshot={slides} onClose={()=>setSlides(null)} onOpenNote={openLinkedNote} onWikiOpen={openWiki}/>}
    {historyJob && sessions[historyJob.path] && <FileHistoryDialog key={`${historyJob.generation}:${historyJob.path}`} path={historyJob.path} content={sessions[historyJob.path].content} blocked={recoveries[historyJob.path]?"请先处理待恢复草稿，再还原快照。":sessions[historyJob.path].conflict?"请先处理外部修改或保存冲突，再还原快照。":""} restoring={historyRestoring} onRestore={restoreHistory} onClose={closeHistory}/>}
    {fileMenu && <div className="file-menu" role="menu" style={{ left: `max(8px, min(${fileMenu.x}px, calc(100vw - 212px)))`, top: `max(8px, min(${fileMenu.y}px, calc(100vh - 310px)))` }} onClick={(event) => event.stopPropagation()}>
      <span title={fileMenu.path}>{fileMenu.path || "根目录"}</span>
      {workspace === "notes" && <><button type="button" role="menuitem" onClick={()=>{const folder=findEntry(entries,fileMenu.path)?.isDirectory?fileMenu.path:parentOf(fileMenu.path);setFileMenu(null);void createCanvasFile(folder);}}>新建知识画布</button><button type="button" role="menuitem" onClick={()=>{const folder=findEntry(entries,fileMenu.path)?.isDirectory?fileMenu.path:parentOf(fileMenu.path);setFileMenu(null);void createDrawingFile(folder);}}>新建绘图白板</button>{[[false, "新建笔记"], [true, "新建文件夹"]].map(([directory, label]) => <button type="button" role="menuitem" key={String(label)} onClick={() => { const folder = findEntry(entries, fileMenu.path)?.isDirectory ? fileMenu.path : parentOf(fileMenu.path); setFileMenu(null); void createItem(Boolean(directory), folder); }}>{label}</button>)}{session && <button type="button" role="menuitem" onClick={() => { revealInTree(session.note.path); setFileMenu(null); }}>定位当前笔记</button>}<hr /></>}
      <button type="button" role="menuitem" disabled={!fileMenu.path} onClick={() => { const path = fileMenu.path; setFileMenu(null); void copyTreeValue(path, "relative"); }}>复制相对路径</button>
      {fileMenu.path && (!web || isDocument(fileMenu.path)) && <button type="button" role="menuitem" onClick={() => { const path = fileMenu.path; setFileMenu(null); void copyTreeValue(path, "absolute"); }}>{web ? "复制网页地址" : "复制绝对路径"}</button>}
      {isMarkdown(fileMenu.path) && !findEntry(entries, fileMenu.path)?.isDirectory && <button type="button" role="menuitem" disabled={busy} onClick={() => { const path = fileMenu.path; setFileMenu(null); void openOnRight(path); }}>在右侧打开</button>}
      {isMarkdown(fileMenu.path) && !findEntry(entries, fileMenu.path)?.isDirectory && <button type="button" role="menuitem" onClick={() => { const path = fileMenu.path; setFileMenu(null); void copyTreeValue(path, "wiki"); }}>复制 Wiki 链接</button>}
      {isDrawing(fileMenu.path) && !findEntry(entries, fileMenu.path)?.isDirectory && <button type="button" role="menuitem" onClick={() => { const path = fileMenu.path; setFileMenu(null); void copyTreeValue(path, "drawing-embed"); }}>复制白板嵌入语法</button>}
      {fileMenu.path && !findEntry(entries, fileMenu.path)?.isDirectory && <button type="button" role="menuitem" disabled={!session} title="相对于当前笔记，粘贴后可直接打开" onClick={() => { const path = fileMenu.path; setFileMenu(null); void copyTreeValue(path, "markdown"); }}>复制 Markdown 链接</button>}
      <hr />
      {([['rename', '重命名'], ['move', '移动'], ['delete', '删除']] as const).filter(([action]) => fileMenu.path && !(workspace === "tasks" && groups.includes(fileMenu.path) && action === "move")).map(([action, label]) => <button type="button" role="menuitem" key={action} onClick={() => { const target = fileMenu.path; setFileMenu(null); if (action === "rename" && workspace === "notes") beginRename(target); else void changeItem(action, target); }}>{label}</button>)}
    </div>}
    {palette && <QuickPalette kind={palette} items={palette === "files" ? paletteFiles : commands} onClose={() => setPalette(null)} onChoose={(id) => { const kind = palette; setPalette(null); if (kind === "files") void openNote(id); else commands.find((command) => command.id === id)?.run(); }} />}
    {imagePreview && <ImageViewer src={imagePreview.src} name={imagePreview.name} onClose={() => setImagePreview(null)} />}
    {pdfPreview && <PdfViewer path={pdfPreview.path} initialPage={pdfPreview.page} scope={workspaceKey.current ?? runtime.kind + ":" + vault} onClose={() => setPdfPreview(null)} onBlockClose={onPdfBlockClose} />}
    {settingsOpen && <SettingsDialog preferences={preferences} onChange={updatePreferences} onClose={() => setSettingsOpen(false)} web={web}
      onWebDav={vault&&desktop.webdavSync?()=>{setSettingsOpen(false);setWebdavOpen(true);}:undefined}
      exportActions={{
        note: canExportNote ? () => { void beginExport(); } : undefined,
        batch: canBatchExport ? () => setBatchPicker(true) : undefined,
        zip: canExportVault ? () => { void exportVaultZip(); } : undefined,
      }} />}
    {vault&&desktop.webdavSync&&desktop.webdavTest&&<WebDavDialog key={canvasScope} open={webdavOpen} scope={workspaceKey.current??runtime.kind+":"+vault} web={web} onClose={()=>setWebdavOpen(false)} onRun={syncWebDav} onTest={desktop.webdavTest} onOpen={path=>{if(isDocument(path))void openNote(path);else void desktop.openItem(path).catch(cause=>setError(message(cause)));}}/>}
    {movePicker && <FolderPicker source={movePicker.source} entries={entries} onChoose={(folder) => { movePicker.resolve(folder); setMovePicker(null); }} onCancel={() => { movePicker.resolve(null); setMovePicker(null); }} />}
    {wikiChoices && <div className="modal-backdrop"><div className="modal wiki-choice" role="dialog" aria-modal="true" aria-labelledby="wiki-choice-title" onKeyDown={(event) => { if (event.key === "Escape") setWikiChoices(null); }}>
      <h2 id="wiki-choice-title">选择链接目标</h2><p>“{wikiChoices.target}”匹配多篇笔记，请选择：</p>
      {wikiChoices.paths.map((path, index) => <button type="button" autoFocus={index === 0} key={path} onClick={() => { const choice=wikiChoices;setWikiChoices(null);if(choice.sequence===navigationSequence.current)void requestWiki(choice.target,choice.source,path); }}>{path}</button>)}
      <div className="modal-actions"><button type="button" onClick={() => setWikiChoices(null)}>取消</button></div>
    </div></div>}
    {copyText !== null && <div className="modal-backdrop copy-text-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label="手动复制"><h2>复制内容</h2><p>当前浏览器无法直接写入剪贴板，请选中后复制。</p><textarea className="copy-text" readOnly value={copyText} autoFocus onFocus={(event) => event.currentTarget.select()} /><div className="modal-actions"><button type="button" onClick={() => setCopyText(null)}>关闭</button></div></div></div>}
    {trashItems !== null && <div className="modal-backdrop"><div className="modal trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-title"><h2 id="trash-title">回收站</h2><p>恢复到原位置；同名文件不会覆盖。回收站数据保存在挂载知识库中。</p>{!trashItems.length && <p>回收站为空</p>}{trashItems.map((item) => <div className="trash-item" key={item.id}><span>{item.path}<small> · {new Date(item.deletedAt * 1000).toLocaleString()}</small></span><button type="button" disabled={busy} onClick={async () => { setWorking(true); try { await desktop.restore!(item.id); setTrashItems(await desktop.trash!()); await refreshLists(); setNotice(`已恢复：${item.path}`); } catch (cause) { setError(message(cause)); } finally { setWorking(false); resumePending(); } }}>恢复</button></div>)}<div className="modal-actions"><button type="button" disabled={busy} onClick={() => setTrashItems(null)}>关闭</button></div></div></div>}
    {dialog && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === "Escape") { event.preventDefault(); finishDialog(null); } }} onSubmit={(event) => { event.preventDefault(); finishDialog(dialog.value === undefined ? "confirm" : dialogValue); }}>
      <h2 id="modal-title">{dialog.title}</h2>{dialog.description && <p>{dialog.description}</p>}
      {dialog.choices ? <select autoFocus aria-label={dialog.title} value={dialogValue} onChange={(event) => setDialogValue(event.target.value)}>{dialog.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : dialog.value !== undefined && <input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} />}
      <div className="modal-actions"><button type="button" autoFocus={dialog.value === undefined} onClick={() => finishDialog(null)}>取消</button><button type="submit" className="primary">确定</button></div>
    </form></div>}
  </main>;
}
