"use client";

import { useEffect, useRef, useState } from "react";
import { autoSaveDelays, defaultPreferences, selectTheme, toggleThemePreference, type AppPreferences } from "../lib/workspace-state";
import { themes } from "../lib/themes";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { StorageDiagnosticsPanel } from "./storage-diagnostics";
import { ExportPresetSettings } from "./export-preset-settings";

type ExportActions = { note?: () => void; batch?: () => void; zip?: () => void };

// A small subset of Noteriv SettingsModal: appearance, editor and workspace.
export function SettingsDialog({ preferences, onChange, onClose, web, onWebDav, exportActions }: { preferences: AppPreferences; onChange: (value: AppPreferences) => void; onClose: () => void; web: boolean; onWebDav?:()=>void; exportActions: ExportActions }) {
  const [section, setSection] = useState<"appearance" | "workspace" | "exports" | "storage" | "shortcuts" | "about">("appearance");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (document.activeElement === document.body) previous?.focus(); };
  }, []);
  const update = (patch: Partial<AppPreferences>) => onChange({ ...preferences, ...patch });
  const runExport = (action: () => void) => { onClose(); action(); };
  return <div className="modal-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><h2 id="settings-title">软件设置</h2><button type="button" aria-label="关闭设置" onClick={onClose}>×</button></header>
    <div className="settings-body"><nav aria-label="设置分类">{([["appearance", "外观与编辑"], ["workspace", "工作区"], ["exports", "导出与备份"], ["storage", "存储与诊断"], ["shortcuts", "快捷键"], ["about", "关于"]] as const).map(([id, name]) => <button type="button" key={id} aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)}>{name}</button>)}</nav>
      <section className="settings-content">
        {section === "appearance" && <><h3>外观与编辑</h3>
          <label>主题明暗<select aria-label="主题" value={preferences.theme} onChange={(event) => { if(event.target.value!==preferences.theme)onChange(toggleThemePreference(preferences)); }}><option value="dark">深色</option><option value="light">浅色</option></select></label>
          <div className="theme-picker" role="group" aria-label="选择主题">{themes.map(item=><button key={item.id} type="button" className="theme-card" aria-label={item.name} aria-pressed={preferences.themeId===item.id} onClick={()=>onChange(selectTheme(preferences,item.id))}>
            <span className="theme-swatch" aria-hidden="true" style={{background:item.colors.primary,color:item.colors.text,borderColor:item.colors.border}}><span className="theme-swatch-sidebar" style={{background:item.colors.secondary}}/><span className="theme-swatch-content"><i style={{background:item.colors.text}}/><i style={{background:item.colors.subtext}}/><i style={{background:item.colors.accent}}/></span></span>
            <span className="theme-card-caption"><strong>{item.name}{preferences.themeId===item.id && <span className="theme-current" aria-hidden="true">✓ 当前</span>}</strong><small>{item.mode==="dark"?"深色":"浅色"} · {item.description}</small></span>
          </button>)}</div>
          <label>编辑字体<select aria-label="编辑字体" value={preferences.font} onChange={(event) => update({ font: event.target.value as AppPreferences["font"] })}><option value="default">默认等宽字体</option><option value="system">系统字体</option><option value="consolas">Consolas</option><option value="cascadia">Cascadia Code</option></select></label>
          <label>字号<input aria-label="字号" type="number" min={12} max={28} value={preferences.fontSize} onChange={(event) => { const value = Number(event.target.value); if (value >= 12 && value <= 28) update({ fontSize: value }); }} /><span>px</span></label>
          <label>行高<select aria-label="行高" value={preferences.lineHeight} onChange={(event) => update({ lineHeight: Number(event.target.value) })}>{[1.4, 1.5, 1.7, 1.8, 2, 2.2].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>正文宽度<select aria-label="正文宽度" value={preferences.contentWidth} onChange={(event) => update({ contentWidth: Number(event.target.value) })}><option value={720}>紧凑 · 720 px</option><option value={880}>适中 · 880 px</option><option value={1040}>宽 · 1040 px</option><option value={1200}>更宽 · 1200 px</option><option value={0}>适应窗口</option></select></label>
          <label>新笔记默认视图<select aria-label="新笔记默认视图" value={preferences.defaultMode} onChange={(event) => update({ defaultMode: event.target.value as AppPreferences["defaultMode"] })}><option value="live">实时编辑</option><option value="source">源码</option><option value="preview">阅读</option><option value="split">编辑与预览</option></select></label>
        </>}
        {section === "workspace" && <><h3>工作区</h3><label className="settings-check"><input type="checkbox" checked={preferences.restoreWorkspace} onChange={(event) => update({ restoreWorkspace: event.target.checked })} />重开时恢复标签和布局</label>
          <label className="settings-check"><input type="checkbox" checked={preferences.autoCollapseSidebar} onChange={(event) => update({ autoCollapseSidebar: event.target.checked })} />窄窗口自动收起侧栏</label>
          <label>自动保存延迟<select aria-label="自动保存延迟" value={preferences.autoSaveDelay} onChange={event => update({ autoSaveDelay: Number(event.target.value) })}>{autoSaveDelays.map(delay => <option key={delay} value={delay}>{delay === 1600 ? "1.6 秒（默认）" : delay === 60000 ? "1 分钟" : `${delay / 1000} 秒`}</option>)}</select></label>
          <h4 className="settings-subtitle">标题栏小组件</h4>
          <label className="settings-check"><input type="checkbox" checked={preferences.showNoteHeatmap} onChange={event => update({ showNoteHeatmap: event.target.checked })}/>显示笔记热力图</label>
          <label className="settings-check"><input type="checkbox" checked={preferences.showNoteDashboard} onChange={event => update({ showNoteDashboard: event.target.checked })}/>显示仪表盘</label>
          {onWebDav&&<div className="settings-info"><button type="button" onClick={onWebDav}>配置 WebDAV 同步</button></div>}
        </>}
        {section === "exports" && <><h3>导出与备份</h3>
          <div className="settings-export-actions">
            <button type="button" disabled={!exportActions.note} onClick={() => exportActions.note && runExport(exportActions.note)}>导出当前笔记 <span>HTML / PDF</span></button>
            <button type="button" disabled={!exportActions.batch} onClick={() => exportActions.batch && runExport(exportActions.batch)}>多篇合并导出 <span>HTML / PDF</span></button>
            <button type="button" disabled={!exportActions.zip} onClick={() => exportActions.zip && runExport(exportActions.zip)}>导出整库 ZIP</button>
          </div>
          <p className="settings-hint">整库 ZIP 打包已保存的文件，包括笔记、附件、画布和白板。</p>
          <ExportPresetSettings presets={preferences.exportPresets} defaultName={preferences.defaultExportPreset} onChange={update}/>
        </>}
        {section === "shortcuts" && <><h3>快捷键</h3><dl className="shortcut-list">{[["保存", "Ctrl / ⌘ + S"], ["另存为", "Ctrl / ⌘ + Shift + S"], ["加粗 / 斜体", "Ctrl / ⌘ + B / I"], ["插入链接", "Ctrl / ⌘ + K"], ["打开 Wiki 链接", "Ctrl / ⌘ + Enter"], ["查找 / 替换", "Ctrl / ⌘ + F / H"], ["显示标题大纲", "Ctrl / ⌘ + Shift + O"], ["软件设置", "Ctrl / ⌘ + ,"], ["重命名所选文件", "F2（文件树内）"], ["关闭标签", "Ctrl / ⌘ + W"], ["切换标签", "Ctrl / ⌘ + Tab"]].map(([name, key]) => <div key={name}><dt>{name}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl>{web && <p className="settings-hint">浏览器可能优先处理部分快捷键，可使用标签关闭按钮、右键菜单和方向键。</p>}</>}
        {section === "storage" && <StorageDiagnosticsPanel/>}
        {section === "about" && <AboutBuild web={web}/>}
      </section></div>
    <footer>{section !== "about" && section !== "storage" && <button type="button" onClick={() => onChange({ ...defaultPreferences, exportPresets: preferences.exportPresets, defaultExportPreset: preferences.defaultExportPreset })}>还原默认设置</button>}<button type="button" className="primary" onClick={onClose}>完成</button></footer>
  </div></div>;
}

const repositoryUrl = "https://github.com/chongweiwang/Noto";
const repositorySsh = "git@github.com:chongweiwang/Noto.git";

function AboutBuild({ web }: { web: boolean }) {
  const { api } = useWorkspaceRuntime();
  const [linkError, setLinkError] = useState("");
  const version = process.env.NEXT_PUBLIC_NOTO_VERSION;
  const revision = process.env.NEXT_PUBLIC_NOTO_REVISION;
  const builtAt = process.env.NEXT_PUBLIC_NOTO_BUILT_AT;
  const localChanges = process.env.NEXT_PUBLIC_NOTO_LOCAL_CHANGES === "1";

  return <><h3>关于 Noto</h3><dl className="shortcut-list build-details">
    <div><dt>应用版本</dt><dd>{version || "开发环境"}</dd></div>
    <div><dt>构建版本</dt><dd>{revision ? <><code>{revision}</code>{localChanges && " · 含本地改动"}</> : "未标记"}</dd></div>
    <div><dt>构建时间</dt><dd>{builtAt ? <time dateTime={builtAt} title={builtAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(builtAt))}</time> : "未记录"}</dd></div>
    <div><dt>运行方式</dt><dd>{web ? "网页端" : "桌面端"}</dd></div>
    <div><dt>项目仓库</dt><dd><a href={repositoryUrl} target="_blank" rel="noopener noreferrer" onClick={web ? undefined : event => {
      event.preventDefault();
      setLinkError("");
      void api.openExternal(repositoryUrl).catch(() => setLinkError("无法打开项目仓库链接。"));
    }}><code>{repositorySsh}</code></a></dd></div>
  </dl>{linkError && <p className="about-link-error" role="alert">{linkError}</p>}</>;
}
