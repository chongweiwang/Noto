"use client";
import {referenceIssueText} from "../lib/knowledge";

// Layout, Canvas drawing, camera and hit-testing adapted from Noteriv GraphView.
// Noto supplies resolved relations and workspace actions, never native file APIs.
import { useEffect, useMemo, useRef, useState } from "react";
import { getTheme } from "../lib/themes";
import { graphEdgeEndpoints, graphNodeRadius, separateGraphNodes } from "../lib/graph-geometry";
import { filterGraph, graphDisplayLimit, type KnowledgeGraph, type GraphNode } from "../lib/knowledge-graph";
import { WorkspaceIcon } from "./workspace-icon";
import type { GraphSettings } from "../lib/workspace-state";
import type { NoteReference, Snapshot } from "../lib/knowledge";

type Point = { x: number; y: number; vx: number; vy: number };
export function KnowledgeGraphView({ graph, settings, currentNote = null, onChange, onOpen, active, loading, errors, issues, theme }: {
  graph: KnowledgeGraph; settings: GraphSettings; onChange: (patch: Partial<GraphSettings>) => void;
  currentNote?: string | null;
  onOpen: (path: string) => void; active: boolean; loading: boolean; errors: Snapshot["errors"];
  issues: NoteReference[]; theme: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false), [focusListOpen, setFocusListOpen] = useState(false);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), host = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null), hoverPosition = useRef({ x: 12, y: 12 });
  const points = useRef(new Map<string, Point>());
  const camera = useRef({ x: 0, y: 0, zoom: 1 }), size = useRef({ width: 800, height: 500 });
  const redraw = useRef(() => {}), reheat = useRef(() => {}), fitKey = useRef("");
  const pendingLocate = useRef<string | null>(null), locateAnchor = useRef<string | null>(null);
  const autoFit = useRef(true);
  const simulationProgress = useRef({ key: "", ticks: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; moved: boolean; node: string | null } | null>(null);
  const lastCompleteGraph = useRef(graph);
  if (active && !loading) lastCompleteGraph.current = graph;
  const visibleGraph = active && loading ? lastCompleteGraph.current : graph;
  const shown = useMemo(() => filterGraph(visibleGraph, settings, selected, currentNote), [visibleGraph, settings.mode, settings.center, settings.folder, settings.isolated, selected, currentNote]);
  const maxConnections = useMemo(() => Math.max(0, ...shown.nodes.map((node) => node.connections)), [shown.nodes]);
  // File polling produces new arrays even when the displayed graph is unchanged.
  const layoutKey = useMemo(() => JSON.stringify([shown.nodes.map((node) => node.id).sort(), shown.edges.map((edge) => JSON.stringify([edge.source, edge.target])).sort()]), [shown]);
  const renderState = useRef({ shown, selected, currentNote, maxConnections, mode: settings.mode, center: settings.center });
  renderState.current = { shown, selected, currentNote, maxConnections, mode: settings.mode, center: settings.center };
  const folders = useMemo(() => {
    const result = new Set<string>();
    for (const node of visibleGraph.nodes) { const parts = node.id.split("/"); parts.pop(); while (parts.length) { result.add(parts.join("/")); parts.pop(); } }
    return [...result].sort((a, b) => a.localeCompare(b));
  }, [visibleGraph]);
  const query = settings.query.trim().toLocaleLowerCase();
  const highlight = useRef({ hovered, query }); highlight.current = { hovered, query };
  const themeColors=useRef(getTheme(theme).colors);themeColors.current=getTheme(theme).colors;
  useEffect(()=>{redraw.current();},[theme]);
  useEffect(() => { redraw.current(); }, [hovered, query]);
  useEffect(() => { redraw.current(); }, [shown, selected, currentNote]);
  useEffect(() => { if (!active) setFocusMode(false); }, [active]);
  const matches = useMemo(() => shown.scope.filter((node) => !query || node.id.toLocaleLowerCase().includes(query)), [shown.scope, query]);
  const current = shown.nodes.find((node) => node.id === (hovered ?? selected));
  const filterKey = settings.mode + "\0" + (settings.mode === "local" ? settings.center : "") + "\0" + settings.folder + "\0" + settings.isolated;
  const visibleList = focusMode ? focusListOpen : listOpen;

  function fit(schedule = true) {
    const visible = renderState.current.shown.nodes.map((node) => points.current.get(node.id)).filter((point): point is Point => !!point);
    if (!visible.length) return;
    const xs = visible.map((point) => point.x), ys = visible.map((point) => point.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const marginX = Math.min(60, size.current.width / 4), marginTop = Math.min(80, size.current.height / 4), marginBottom = Math.min(130, size.current.height / 3);
    const zoom = Math.max(.02, Math.min(1.5, (size.current.width - 2 * marginX) / Math.max(1, right - left), (size.current.height - marginTop - marginBottom) / Math.max(1, bottom - top)));
    camera.current = { x: (left + right) / 2, y: (top + bottom) / 2 + (marginBottom - marginTop) / (2 * zoom), zoom };
    if (schedule) redraw.current();
  }
  function nodeRadius(node: GraphNode) {
    const { shown, selected, currentNote, center, mode, maxConnections } = renderState.current;
    const radius = graphNodeRadius(node.connections, maxConnections, camera.current.zoom, shown.nodes.length);
    return node.id === selected || node.id === currentNote || node.id === highlight.current.hovered || mode === "local" && node.id === center ? Math.max(7, radius) : radius;
  }
  function zoom(factor: number) { autoFit.current = false; camera.current.zoom = Math.max(.02, Math.min(4, camera.current.zoom * factor)); redraw.current(); }
  function openNote(path: string) { setFocusMode(false); onOpen(path); }
  function locate(node: GraphNode) {
    autoFit.current = false;
    pendingLocate.current = node.id; locateAnchor.current = node.id;
    setSelected(node.id);
    const point = points.current.get(node.id);
    if (point) { camera.current = { x: point.x, y: point.y, zoom: Math.max(.8, camera.current.zoom) }; pendingLocate.current = null; redraw.current(); }
  }

  useEffect(() => {
    if (!active || !canvas.current || !host.current) return;
    const element = canvas.current, container = host.current;
    const ctx = element.getContext("2d");
    if (!ctx) { setCanvasUnavailable(true); return; }
    setCanvasUnavailable(false);
    const nodeIds = new Set(shown.nodes.map((node) => node.id));
    if (locateAnchor.current && !nodeIds.has(locateAnchor.current)) locateAnchor.current = null;
    for (const id of points.current.keys()) if (!nodeIds.has(id)) points.current.delete(id);
    shown.nodes.forEach((node, index) => {
      if (!points.current.has(node.id)) {
        const angle = index * 2.399963, radius = Math.sqrt(index + 1) * 24;
        points.current.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
      }
    });
    const selectedPoint = pendingLocate.current && points.current.get(pendingLocate.current);
    if (selectedPoint) { camera.current = { x: selectedPoint.x, y: selectedPoint.y, zoom: Math.max(.8, camera.current.zoom) }; pendingLocate.current = null; }
    if (simulationProgress.current.key !== layoutKey) simulationProgress.current = { key: layoutKey, ticks: 0 };
    let frame = 0, ticks = simulationProgress.current.ticks, disposed = false;
    const project = (point: Point) => ({ x: (point.x - camera.current.x) * camera.current.zoom + size.current.width / 2, y: (point.y - camera.current.y) * camera.current.zoom + size.current.height / 2 });
    function arrow(x: number, y: number, angle: number) {
      ctx!.beginPath(); ctx!.moveTo(x, y); ctx!.lineTo(x - Math.cos(angle - .45) * 6, y - Math.sin(angle - .45) * 6); ctx!.lineTo(x - Math.cos(angle + .45) * 6, y - Math.sin(angle + .45) * 6); ctx!.closePath(); ctx!.fill();
    }
    function paint() {
      ctx!.clearRect(0, 0, size.current.width, size.current.height);
      const colors=themeColors.current,text=colors.text,accent=colors.accent;
      const { shown, selected, currentNote, center: centerId, mode } = renderState.current;
      const nodesById = new Map(shown.nodes.map((node) => [node.id, node]));
      const query = highlight.current.query, requestedFocus = highlight.current.hovered ?? selected;
      const focus = shown.nodes.some((node) => node.id === requestedFocus) ? requestedFocus : null;
      const matchedNodes = new Set(query ? shown.nodes.filter((node) => node.id.toLocaleLowerCase().includes(query)).map((node) => node.id) : []);
      const neighbors = new Set<string>(focus ? [focus] : []);
      if (focus) for (const edge of shown.edges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
      const backgroundAlpha = Math.max(.06, Math.min(.32, .32 * Math.sqrt(100 / Math.max(1, shown.nodes.length))));
      for (const edge of shown.edges) {
        const from = points.current.get(edge.source), to = points.current.get(edge.target);
        if (!from || !to) continue;
        const a = project(from), b = project(to);
        const ends = graphEdgeEndpoints(a, b, nodeRadius(nodesById.get(edge.source)!), nodeRadius(nodesById.get(edge.target)!));
        if (!ends) continue;
        const linked=!!focus&&(edge.source===focus||edge.target===focus);
        ctx!.strokeStyle=linked?accent:colors.muted;ctx!.fillStyle=ctx!.strokeStyle;
        ctx!.globalAlpha = query && !matchedNodes.has(edge.source) && !matchedNodes.has(edge.target) ? backgroundAlpha * .3 : focus && !linked ? backgroundAlpha * .4 : linked ? .9 : backgroundAlpha;
        ctx!.lineWidth = linked ? 1.5 : 1;
        ctx!.beginPath(); ctx!.moveTo(ends.start.x, ends.start.y); ctx!.lineTo(ends.end.x, ends.end.y); ctx!.stroke();
        if (camera.current.zoom > .45 || shown.nodes.length < 120) {
          if (edge.forward) arrow(ends.end.x, ends.end.y, ends.angle);
          if (edge.reverse) arrow(ends.start.x, ends.start.y, ends.angle + Math.PI);
        }
      }
      ctx!.textAlign = "center"; ctx!.textBaseline = "top";
      const layers: GraphNode[][] = [[], [], [], []];
      for (const node of shown.nodes) {
        const rank = node.id === focus ? 3 : node.id === selected || matchedNodes.has(node.id) ? 2 : node.id === currentNote || mode === "local" && node.id === centerId ? 1 : 0;
        layers[rank].push(node);
      }
      for (const node of layers.flat()) {
        const point = points.current.get(node.id);
        if (!point) continue;
        const p = project(point);
        if (p.x < -80 || p.y < -40 || p.x > size.current.width + 80 || p.y > size.current.height + 40) continue;
        const matched = !query || matchedNodes.has(node.id);
        ctx!.globalAlpha = !matched || focus && !neighbors.has(node.id) ? .18 : 1;
        const radius = nodeRadius(node);
        const center=node.id===centerId&&mode==="local", current=node.id===currentNote;
        const emphasized = node.id === focus || node.id === selected || current;
        ctx!.fillStyle = node.unreadable ? colors.danger : center ? colors.green : emphasized ? accent : colors.surface;
        ctx!.strokeStyle = node.unreadable ? colors.danger : center ? colors.green : accent;
        ctx!.lineWidth = emphasized || center ? 2 : 1.2;
        ctx!.beginPath(); ctx!.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx!.fill(); ctx!.stroke();
        if (node.id === selected || center || current) { ctx!.strokeStyle = text; ctx!.lineWidth = 1; ctx!.beginPath(); ctx!.arc(p.x, p.y, radius + 3, 0, Math.PI * 2); ctx!.stroke(); }
        if (shown.nodes.length < 60 || camera.current.zoom > .6 && shown.nodes.length < 180 || camera.current.zoom > 1.5 || node.id === focus || current || query && matched && matchedNodes.size <= 30) {
          ctx!.font = `${emphasized ? "600" : "400"} 12px Inter, "Segoe UI", "Microsoft YaHei", sans-serif`;
          ctx!.fillStyle = emphasized ? text : colors.subtext; ctx!.fillText(node.label.length > 26 ? node.label.slice(0, 25) + "…" : node.label, p.x, p.y + radius + 5);
        }
      }
      ctx!.globalAlpha = 1; ctx!.lineWidth = 1;
    }
    function separate(pinned: string | null) {
      const { nodes } = renderState.current.shown;
      if (nodes.length >= 40) separateGraphNodes(nodes.flatMap((node) => { const point = points.current.get(node.id); return point ? [{ id: node.id, point, radius: nodeRadius(node) }] : []; }), camera.current.zoom, pinned);
    }
    function simulate() {
      const { nodes, edges } = renderState.current.shown, stride = Math.max(1, Math.floor(nodes.length / 64));
      const pinned = drag.current?.node ?? locateAnchor.current;
      // Bounded sampling on dense graphs; keep every node and relationship in the model.
      for (let i = 0; i < nodes.length; i++) {
        const a = points.current.get(nodes[i].id);
        if (!a) continue;
        if (pinned === nodes[i].id) continue;
        for (let j = ticks % stride; j < nodes.length; j += stride) {
          if (i === j) continue;
          const b = points.current.get(nodes[j].id);
          if (!b) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          const distance = Math.max(30, dx * dx + dy * dy);
          const force = 600 * Math.min(stride, 5) / distance;
          a.vx += dx * force; a.vy += dy * force;
        }
        a.vx -= a.x * .002; a.vy -= a.y * .002;
      }
      for (const edge of edges) {
        const a = points.current.get(edge.source), b = points.current.get(edge.target);
        if (!a || !b) continue;
        const dx = (b.x - a.x) * .003, dy = (b.y - a.y) * .003;
        if (pinned !== edge.source) { a.vx += dx; a.vy += dy; }
        if (pinned !== edge.target) { b.vx -= dx; b.vy -= dy; }
      }
      for (const [id, point] of points.current) {
        if (pinned === id) { point.vx = 0; point.vy = 0; continue; }
        point.vx *= .8; point.vy *= .8;
        point.x += Math.max(-12, Math.min(12, point.vx)); point.y += Math.max(-12, Math.min(12, point.vy));
      }
      separate(pinned);
    }
    function tick() {
      frame = 0;
      if (disposed || document.hidden) return;
      const running = !drag.current || !!drag.current.node && drag.current.moved;
      let settling = false;
      if (ticks < 140 && running) { simulate(); simulationProgress.current.ticks = ++ticks; settling = ticks === 140; }
      if (autoFit.current) fit(false);
      // Auto-fit changes screen-space distances; finish separating at the final zoom.
      if (settling) for (let pass = 0; pass < 4; pass++) separate(drag.current?.node ?? locateAnchor.current);
      if (ticks >= 140) locateAnchor.current = null;
      paint();
      if (ticks < 140 && renderState.current.shown.nodes.length > 0 && running) frame = requestAnimationFrame(tick);
    }
    function wake() { if (!disposed && !frame && !document.hidden) frame = requestAnimationFrame(tick); }
    redraw.current = wake;
    reheat.current = () => { simulationProgress.current.ticks = ticks = Math.min(ticks, 80); wake(); };
    function resize() {
      const rect = container.getBoundingClientRect();
      size.current = { width: Math.max(1, rect.width || 800), height: Math.max(1, rect.height || 500) };
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = size.current.width * ratio; element.height = size.current.height * ratio;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (fitKey.current !== filterKey) { fitKey.current = filterKey; autoFit.current = true; }
      if (autoFit.current) fit(false);
      wake();
    }
    function visibility() { if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; } else wake(); }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(container); resize();
    document.addEventListener("visibilitychange", visibility);
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoom(Math.exp(-event.deltaY * .0015)); };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { disposed = true; if (frame) cancelAnimationFrame(frame); observer?.disconnect(); element.removeEventListener("wheel", wheel); document.removeEventListener("visibilitychange", visibility); redraw.current = () => {}; reheat.current = () => {}; drag.current = null; };
  }, [active, layoutKey, filterKey]);

  function pointer(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const cam = camera.current;
    let hit: GraphNode | undefined, bestDistance = Infinity, bestPriority = -1;
    for (const node of shown.nodes) {
      const p = points.current.get(node.id); if (!p) continue;
      const distance = Math.hypot((p.x - cam.x) * cam.zoom + size.current.width / 2 - x, (p.y - cam.y) * cam.zoom + size.current.height / 2 - y), radius = nodeRadius(node);
      if (distance > radius + 5) continue;
      const important = node.id === hovered || node.id === selected || node.id === currentNote || settings.mode === "local" && node.id === settings.center || !!query && node.id.toLocaleLowerCase().includes(query);
      const priority = important && distance <= radius ? 1 : 0;
      if (priority > bestPriority || priority === bestPriority && distance < bestDistance) { hit = node; bestDistance = distance; bestPriority = priority; }
    }
    return { x, y, hit };
  }
  return <div className={"graph-workspace" + (focusMode ? " is-focused" : "")} onKeyDown={(event) => {
    if (focusMode && event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setFocusMode(false); }
  }}>
    <header className="graph-header"><h1>知识图谱</h1><div className="graph-modes" role="group" aria-label="图谱范围">
      <button type="button" aria-pressed={settings.mode === "global"} onClick={() => onChange({ mode: "global" })}>全库图谱</button>
      <button type="button" aria-pressed={settings.mode === "local"} onClick={() => onChange({ mode: "local" })}>局部图谱</button>
    </div><div className="graph-toolbar"><label>目录<select aria-label="图谱目录" value={settings.folder} onChange={(event) => onChange({ folder: event.target.value })}><option value="">全部目录</option>{settings.folder && !folders.includes(settings.folder) && <option value={settings.folder}>{settings.folder}（已不存在）</option>}{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select></label>
      <label className="graph-isolated"><input type="checkbox" checked={settings.isolated} onChange={(event) => onChange({ isolated: event.target.checked })} />显示孤立笔记</label>
    </div><button type="button" className="graph-focus-toggle" aria-label={focusMode ? "退出图谱专注模式" : "进入图谱专注模式"} title={focusMode ? "退出专注模式（Esc）" : "专注模式"} aria-pressed={focusMode} onClick={() => { if (!focusMode) setFocusListOpen(false); setFocusMode((value) => !value); }}><WorkspaceIcon name="fit" /> {focusMode ? "退出专注" : "专注"}</button>
    <button type="button" className="graph-list-toggle" aria-label={visibleList ? "收起图谱笔记列表" : "展开图谱笔记列表"} title={visibleList ? "收起笔记列表" : "展开笔记列表"} aria-expanded={visibleList} aria-controls="graph-note-list" onClick={() => focusMode ? setFocusListOpen((open) => !open) : setListOpen((open) => !open)}><WorkspaceIcon name="outline" /></button></header>
    {settings.mode === "local" && <p className="graph-hint">中心：{shown.centerExists ? settings.center : "请选择一篇笔记，在下方结果中设为中心。"}</p>}
    {loading && <p className="graph-hint" role="status">正在刷新已保存笔记的关联，当前结果可能尚未更新…</p>}
    {shown.truncated && <p className="graph-warning">当前范围有 {shown.scope.length} 篇笔记，最多绘制 {graphDisplayLimit} 个节点。请缩小目录范围或搜索定位；上方数量区分完整范围与实际展示。</p>}
    {!!errors.length && <details className="graph-warning"><summary>关联数据不完整：{errors.length} 项读取失败</summary>{errors.map((error) => <p key={error.path}>{error.path}：{error.error}</p>)}</details>}
    <div className={"graph-body" + (visibleList ? "" : " list-collapsed")}><div className="graph-stage" ref={host}>
      <canvas ref={canvas} role="img" tabIndex={0} aria-label="知识图谱画布" aria-description="方向键平移，加减号缩放，0 适应画布。箭头表示引用方向。" onKeyDown={(event) => {
        if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.2); }
        else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.2); }
        else if (event.key === "0") { event.preventDefault(); autoFit.current = true; fit(); }
        else if (event.key === "Enter" && selected) openNote(selected);
        else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); autoFit.current = false; camera.current.x += (event.key === "ArrowRight" ? 40 : event.key === "ArrowLeft" ? -40 : 0) / camera.current.zoom; camera.current.y += (event.key === "ArrowDown" ? 40 : event.key === "ArrowUp" ? -40 : 0) / camera.current.zoom; redraw.current(); }
      }} onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        const p = pointer(event); event.currentTarget.setPointerCapture?.(event.pointerId);
        setHovered(null);
        drag.current = { pointerId: event.pointerId, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false, node: p.hit?.id ?? null };
      }} onPointerMove={(event) => {
        const held = drag.current;
        if (held && event.pointerId !== held.pointerId) return;
        const p = pointer(event);
        if (held) {
          held.moved ||= Math.hypot(p.x - held.startX, p.y - held.startY) > 4;
          if (!held.moved) return;
          autoFit.current = false; locateAnchor.current = null;
          const dx = (p.x - held.x) / camera.current.zoom, dy = (p.y - held.y) / camera.current.zoom;
          const node = held.node && points.current.get(held.node);
          if (node) { node.x += dx; node.y += dy; node.vx = 0; node.vy = 0; }
          else { camera.current.x -= dx; camera.current.y -= dy; }
          held.x = p.x; held.y = p.y; if (node) reheat.current(); else redraw.current();
        } else {
          hoverPosition.current = { x: Math.max(8, Math.min(p.x + 14, size.current.width - 220)), y: Math.max(8, Math.min(p.y + 14, size.current.height - 90)) };
          if (tooltip.current && p.hit) { tooltip.current.style.left = hoverPosition.current.x + "px"; tooltip.current.style.top = hoverPosition.current.y + "px"; }
          event.currentTarget.style.cursor = p.hit ? "pointer" : "grab";
          setHovered(p.hit?.id ?? null);
        }
      }} onPointerUp={(event) => {
        const held = drag.current;
        if (!held || event.pointerId !== held.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (!held.moved && held.node) { setSelected(held.node); openNote(held.node); }
        if (held.moved && held.node) reheat.current(); else redraw.current();
      }} onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; redraw.current(); } }} onPointerLeave={() => { if (!drag.current) setHovered(null); }} />
      <label className="graph-search"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m12.5 12.5 4 4"/></svg><input type="search" aria-label="图谱搜索" maxLength={200} value={settings.query} placeholder="搜索笔记或路径" onChange={(event) => onChange({ query: event.target.value })} /></label>
      <div className="graph-status" aria-live="polite"><span>全库 {visibleGraph.nodes.length} 篇</span><span>范围 {shown.scope.length} 节点 / {shown.totalEdges} 条关系</span><span>展示 {shown.nodes.length} / {shown.edges.length}</span></div>
      <div className="graph-legend" aria-label="图谱图例">{settings.mode === "local" && <span><i className="graph-legend-center"/>中心笔记</span>}{currentNote && <span><i className="graph-legend-current"/>当前笔记</span>}<span><i className="graph-legend-node"/>笔记</span><span><i className="graph-legend-unreadable"/>暂不可读</span></div>
      <div className="graph-zoom-controls" role="group" aria-label="图谱视图控制"><button type="button" aria-label="放大图谱" title="放大" onClick={() => zoom(1.25)}>+</button><button type="button" aria-label="缩小图谱" title="缩小" onClick={() => zoom(.8)}>−</button><button type="button" aria-label="适应视图" title="适应视图" onClick={() => { autoFit.current = true; fit(); }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button><button type="button" aria-label="重置视图" title="重置筛选和视图" onClick={() => { onChange({ folder: "", query: "", isolated: true }); setSelected(null); autoFit.current = true; fit(); }}>↺</button></div>
      {!loading && !shown.nodes.length && <p className="graph-empty">{!visibleGraph.nodes.length ? "知识库中还没有 Markdown 笔记。" : settings.mode === "local" && !shown.centerExists ? "选择一篇笔记作为局部图谱中心。" : "当前筛选范围没有笔记。"}</p>}
      {canvasUnavailable && <p className="graph-empty">当前环境不支持画布，请通过右侧笔记列表访问。</p>}
      {current && <div ref={tooltip} className={"graph-tooltip" + (hovered ? " graph-tooltip-hover" : "")} style={hovered ? { left: hoverPosition.current.x, top: hoverPosition.current.y, bottom: "auto" } : undefined}><strong>{current.label}</strong><span>{current.id}</span><span>{current.connections} 篇关联笔记{current.unreadable ? " · 内容暂不可读" : ""}</span></div>}
    </div><aside id="graph-note-list" hidden={!visibleList} className="graph-notes" aria-label="图谱笔记列表">
      <div className="graph-notes-heading"><strong>笔记列表</strong><span>搜索可定位笔记</span></div>
      <p>{matches.length} 篇匹配{matches.length > 40 ? "，显示前 40 篇" : ""}</p>
      {!matches.length && <p>没有匹配的笔记。</p>}
      <ul>{matches.slice(0, 40).map((node) => <li key={node.id} className={selected === node.id ? "selected" : ""}>
        <button type="button" className="graph-note-open" title={node.id} onClick={() => openNote(node.id)}>{node.label}<small>{node.id}</small></button>
        <div><button type="button" aria-label={"定位 " + node.id} onClick={() => locate(node)}>定位</button><button type="button" aria-label={"设为局部中心 " + node.id} onClick={() => { setSelected(node.id); onChange({ mode: "local", center: node.id }); }}>设为中心</button></div>
      </li>)}</ul>
    </aside></div>
    <footer className="graph-footer">
      <details><summary>链接诊断（{issues.length}）</summary>{issues.slice(0, 40).map((issue, index) => <button type="button" key={issue.source + ":" + issue.from + ":" + index} onClick={() => openNote(issue.source)}>{issue.source} · 第 {issue.line} 行 · {issue.raw} · {referenceIssueText(issue)}</button>)}{issues.length > 40 && <p>显示前 40 项，请在来源笔记的关联面板检查。</p>}</details>
    </footer>
  </div>;
}
