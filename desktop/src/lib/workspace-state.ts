import {isDocument,isMarkdown,isCanvas,isDrawing,isFileTab} from "./document-kind";
import type {CanvasViewport} from "./canvas-document";
import {defaultDrawingStyle,drawingColor,drawingTools,type DrawingStyle,type DrawingTool} from "./drawing-document";
import {eraserMode,eraserSize,type EraserMode,type EraserSize} from "./eraser-settings";
import {defaultDarkTheme,defaultLightTheme,getTheme,isThemeId,type ThemeId} from "./themes";
import { normalizeNotePanes, type NotePanes } from "./note-panes";
import { normalizeExportPresets, type ExportPreset } from "./export-presets";
export {isFileTab};
export type CanvasViewState={viewport:CanvasViewport;selected:string[];eraserSize?:EraserSize;grid?:boolean};
export type DrawingViewState=CanvasViewState&{tool:DrawingTool;style:DrawingStyle;grid:boolean;eraserMode?:EraserMode};
// UI metadata only. Markdown and recovery drafts remain in their existing
// protected file/draft stores. Inspired by Noteriv's WorkspaceState.
export type ViewMode = "live" | "source" | "split" | "preview";
export type Theme = "dark" | "light";
export const graphTabId = "@graph";
export const isNoteTab = isFileTab; // legacy name; Markdown-only callers use isMarkdown.
export interface GraphSettings { mode: "global" | "local"; center: string | null; folder: string; query: string; isolated: boolean }
export const defaultGraphSettings: GraphSettings = { mode: "global", center: null, folder: "", query: "", isolated: true };
export interface TaskViewSettings { view: "list" | "board"; query: string; filter: "all" | "open" | "done"; scrolls: Record<string, number> }
export const defaultTaskViewSettings: TaskViewSettings = { view: "list", query: "", filter: "all", scrolls: {} };
export interface EditorViewState { anchor: number; head: number; scrollTop: number; scrollLeft: number }
export interface AppPreferences {
  theme: Theme; themeId:ThemeId; lastDarkThemeId:ThemeId; lastLightThemeId:ThemeId; font: "default" | "system" | "consolas" | "cascadia";
  fontSize: number; lineHeight: number; contentWidth: number;
  defaultMode: ViewMode; restoreWorkspace: boolean; autoCollapseSidebar: boolean; autoSaveDelay: number;
  showNoteHeatmap: boolean; showNoteDashboard: boolean;
  exportPresets: ExportPreset[]; defaultExportPreset: string;
}
export const preferencesKey = "noto.preferences.v1";
export const autoSaveDelays = [1600, 5000, 10000, 30000, 60000];
export const defaultPreferences: AppPreferences = { theme: "dark", themeId:defaultDarkTheme,lastDarkThemeId:defaultDarkTheme,lastLightThemeId:defaultLightTheme, font: "default", fontSize: 15, lineHeight: 1.7, contentWidth: 880, defaultMode: "live", restoreWorkspace: true, autoCollapseSidebar: true, autoSaveDelay: 1600, showNoteHeatmap: true, showNoteDashboard: true, exportPresets: [], defaultExportPreset: "" };
export function selectTheme(preferences:AppPreferences,id:ThemeId):AppPreferences {
 const mode=getTheme(id).mode;
 return {...preferences,theme:mode,themeId:id,...(mode==="dark"?{lastDarkThemeId:id}:{lastLightThemeId:id})};
}
export function toggleThemePreference(preferences:AppPreferences):AppPreferences {
 return selectTheme(preferences,preferences.theme==="dark"?preferences.lastLightThemeId:preferences.lastDarkThemeId);
}
export const fontFamilies = {
  default: "'JetBrains Mono', 'Fira Code', Consolas, 'Microsoft YaHei', monospace",
  system: "system-ui, 'Microsoft YaHei', sans-serif",
  consolas: "Consolas, 'Microsoft YaHei', monospace",
  cascadia: "'Cascadia Code', Consolas, 'Microsoft YaHei', monospace",
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const range = (value: unknown, min: number, max: number, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export const isViewMode = (value: unknown): value is ViewMode => ["live", "source", "split", "preview"].includes(String(value));
export function normalizePreferences(value: unknown, legacyTheme?: string | null): AppPreferences {
  const data = record(value), theme = data.theme ?? legacyTheme;
  const themeId=isThemeId(data.themeId)?data.themeId:theme==="light"?defaultLightTheme:defaultDarkTheme;
  const lastDarkThemeId=getTheme(themeId).mode==="dark"?themeId:isThemeId(data.lastDarkThemeId)&&getTheme(data.lastDarkThemeId).mode==="dark"?data.lastDarkThemeId:defaultDarkTheme;
  const lastLightThemeId=getTheme(themeId).mode==="light"?themeId:isThemeId(data.lastLightThemeId)&&getTheme(data.lastLightThemeId).mode==="light"?data.lastLightThemeId:defaultLightTheme;
  const exportPresets = normalizeExportPresets(data.exportPresets);
  return {
    theme: getTheme(themeId).mode,themeId,lastDarkThemeId,lastLightThemeId,
    font: ["default", "system", "consolas", "cascadia"].includes(String(data.font)) ? data.font as AppPreferences["font"] : "default",
    fontSize: Math.round(range(data.fontSize, 12, 28, 15)), lineHeight: range(data.lineHeight, 1.4, 2.2, 1.7),
    contentWidth: [0, 720, 880, 1040, 1200].includes(Number(data.contentWidth)) ? Number(data.contentWidth) : 880,
    defaultMode: isViewMode(data.defaultMode) ? data.defaultMode : "live",
    restoreWorkspace: data.restoreWorkspace !== false, autoCollapseSidebar: data.autoCollapseSidebar !== false,
    showNoteHeatmap: (data.showNoteHeatmap ?? data.showCalendarHeatmap) !== false, showNoteDashboard: data.showNoteDashboard !== false,
    exportPresets, defaultExportPreset: exportPresets.find(({ name }) => name === data.defaultExportPreset)?.name ?? "",
    autoSaveDelay: typeof data.autoSaveDelay === "number" && autoSaveDelays.includes(data.autoSaveDelay) ? data.autoSaveDelay : defaultPreferences.autoSaveDelay,
  };
}
export interface WorkspaceState {
  version: 1; tabs: string[]; active: string | null; pinned: string[];
  panes?: NotePanes;
  sidebarCollapsed: boolean; outlineOpen: boolean; sidebarWidth: number; outlineWidth: number; splitRatio: number;
  collapsedFolders: string[]; modes: Record<string, ViewMode>; editors: Record<string, EditorViewState>; previews: Record<string, number>;
  managedFoldersExpanded: boolean;
  selected: string; sidebarView: "files" | "search" | "tags" | "backlinks" | "calendar" | "tasks";
  taskPath: string | null; taskCategory: string | null; taskGroup: string | null;
  canvases?:Record<string,CanvasViewState>;
  drawings?:Record<string,DrawingViewState>;
  graph: GraphSettings;
  tasks: TaskViewSettings;
}
export function emptyWorkspace(): WorkspaceState {
  return { version: 1, tabs: [], active: null, pinned: [], sidebarCollapsed: false, outlineOpen: true, sidebarWidth: 250, outlineWidth: 220, splitRatio: .5, collapsedFolders: [], managedFoldersExpanded: false, modes: {}, editors: {}, previews: {}, selected: "", sidebarView: "files", taskPath: null, taskCategory: null, taskGroup: null, graph: { ...defaultGraphSettings }, tasks: { ...defaultTaskViewSettings, scrolls: {} } };
}
const relative = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length < 4096 && !/[\\:\0]/.test(value) && value.split("/").every((part) => !!part && !part.startsWith("."));
const tab = (value: unknown): value is string => value === "@tasks" || value === graphTabId || relative(value) && isDocument(value);
const list = (value: unknown, valid: (item: unknown) => item is string): string[] => Array.isArray(value) ? [...new Set(value.filter(valid))] : [];
export function orderTabs(tabs: string[], pinned: string[]): string[] {
  const unique = [...new Set(tabs)], pins = new Set(pinned);
  return [...unique.filter((id) => pins.has(id)), ...unique.filter((id) => !pins.has(id))];
}
export function reorderTabs(tabs: string[], from: string, to: string, pinned: string[]): string[] {
  if (!tabs.includes(from) || !tabs.includes(to) || pinned.includes(from) !== pinned.includes(to)) return tabs;
  const next = tabs.filter((id) => id !== from); next.splice(tabs.indexOf(to), 0, from); return next;
}
export function normalizeWorkspace(value: unknown): WorkspaceState {
  const defaults = emptyWorkspace(), data = record(value);
  if (data.version !== 1) return defaults;
  const tabs = list(data.tabs, tab), pinned = list(data.pinned, tab).filter((id) => tabs.includes(id));
  const modes = Object.fromEntries(Object.entries(record(data.modes)).filter(([path, mode]) => tab(path) && isMarkdown(path) && isViewMode(mode))) as Record<string, ViewMode>;
  const graph = record(data.graph), tasks = record(data.tasks);
  const editors: Record<string, EditorViewState> = {};
  for (const [path, raw] of Object.entries(record(data.editors))) {
    if (!tab(path) || !isMarkdown(path)) continue;
    const state = record(raw); editors[path] = { anchor: Math.floor(range(state.anchor, 0, Number.MAX_SAFE_INTEGER, 0)), head: Math.floor(range(state.head, 0, Number.MAX_SAFE_INTEGER, 0)), scrollTop: range(state.scrollTop, 0, 1e8, 0), scrollLeft: range(state.scrollLeft, 0, 1e8, 0) };
  }
  return {
    ...defaults, tabs: orderTabs(tabs, pinned), pinned, active: tabs.includes(String(data.active)) ? String(data.active) : tabs[0] ?? null,
    panes: normalizeNotePanes(data.panes, tabs, tabs.includes(String(data.active)) ? String(data.active) : tabs[0] ?? null),
    sidebarCollapsed: data.sidebarCollapsed === true, outlineOpen: data.outlineOpen !== false,
    sidebarWidth: range(data.sidebarWidth, 180, 520, 250), outlineWidth: range(data.outlineWidth, 180, 420, 220), splitRatio: range(data.splitRatio, .25, .75, .5),
    canvases:Object.fromEntries(Object.entries(record(data.canvases)).filter(([path])=>relative(path)&&isCanvas(path)).map(([path,raw])=>{
      const c=record(raw),v=record(c.viewport);
      return [path,{viewport:{x:range(v.x,-1e10,1e10,0),y:range(v.y,-1e10,1e10,0),zoom:range(v.zoom,.15,3,1)},selected:list(c.selected,(id):id is string=>typeof id==="string"&&id.length<=256).slice(0,1000),eraserSize:eraserSize(c.eraserSize),grid:c.grid!==false}];
    })),
    drawings:Object.fromEntries(Object.entries(record(data.drawings)).filter(([path])=>relative(path)&&isDrawing(path)).map(([path,raw])=>{
      const d=record(raw),v=record(d.viewport),s=record(d.style);
      return [path,{viewport:{x:range(v.x,-1e10,1e10,0),y:range(v.y,-1e10,1e10,0),zoom:range(v.zoom,.15,3,1)},selected:list(d.selected,(id):id is string=>typeof id==="string"&&!!id&&id.length<=256).slice(0,2000),
        tool:drawingTools.includes(d.tool as DrawingTool)?d.tool:"select",grid:d.grid!==false,eraserSize:eraserSize(d.eraserSize),eraserMode:eraserMode(d.eraserMode),
        style:{strokeColor:drawingColor(s.strokeColor)?s.strokeColor:defaultDrawingStyle.strokeColor,fillColor:s.fillColor==="transparent"||drawingColor(s.fillColor)?s.fillColor:defaultDrawingStyle.fillColor,strokeWidth:range(s.strokeWidth,1,16,2),fontSize:range(s.fontSize,12,96,20)}}];
    })) as Record<string,DrawingViewState>,
    collapsedFolders: list(data.collapsedFolders, relative), managedFoldersExpanded: data.managedFoldersExpanded === true, modes, editors,
    previews: Object.fromEntries(Object.entries(record(data.previews)).filter(([path]) => tab(path) && isMarkdown(path)).map(([path, scroll]) => [path, range(scroll, 0, 1e8, 0)])),
    selected: relative(data.selected) ? data.selected : "",
    sidebarView: ["files", "search", "tags", "backlinks", "calendar", "tasks"].includes(String(data.sidebarView)) ? data.sidebarView as WorkspaceState["sidebarView"] : "files",
    taskPath: relative(data.taskPath) ? data.taskPath : null, taskCategory: relative(data.taskCategory) ? data.taskCategory : null, taskGroup: relative(data.taskGroup) ? data.taskGroup : null,
    tasks: { view: tasks.view === "board" ? "board" : "list", query: typeof tasks.query === "string" ? tasks.query.slice(0, 200) : "", filter: tasks.filter === "done" || tasks.filter === "open" ? tasks.filter : "all", scrolls: Object.fromEntries(Object.entries(record(tasks.scrolls)).filter(([key]) => ["list", "board", "todo", "doing", "done"].includes(key)).map(([key, value]) => [key, range(value, 0, 1e8, 0)])) },
    graph: { mode: graph.mode === "local" ? "local" : "global", center: relative(graph.center) && isMarkdown(graph.center) && tab(graph.center) ? graph.center : null, folder: relative(graph.folder) ? graph.folder : "", query: typeof graph.query === "string" ? graph.query.slice(0, 200) : "", isolated: graph.isolated !== false },
  };
}
export const workspaceStorageKey = (kind: string, identity: string) => `noto.workspace.v1:${kind}:${encodeURIComponent(identity)}`;
