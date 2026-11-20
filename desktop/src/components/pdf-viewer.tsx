"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask, TextLayer } from "pdfjs-dist";
import type { PdfAnnotation, PdfAnnotations, PdfRect } from "../lib/vault-api";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";
import { copyText } from "../lib/ui-actions";
import { createPdfTask, type PdfLibrary } from "../lib/pdf-runtime";

interface OpenDocument { pdf: PDFDocumentProxy; library: PdfLibrary; version: string }
interface AnnotationDraft { expectedRevision: string | null; annotations: PdfAnnotation[] }
interface Comment { id?: string; rects: PdfRect[]; text: string; value: string }

const annotationLabels = { highlight: "高亮", underline: "下划线", note: "批注" };
const maxCanvasPixels = 12 * 1024 * 1024;
const readingPadding = 28;
const emptyAnnotations: PdfAnnotation[] = [];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function annotationId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function selectedText(frame: HTMLElement | null) {
  const selection = window.getSelection();
  const layer = frame?.querySelector(".pdf-text-layer");
  if (!frame || !layer || !selection?.rangeCount || selection.isCollapsed ||
      !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return null;
  const bounds = frame.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const rects = Array.from(selection.getRangeAt(0).getClientRects()).flatMap((r) => {
    const x = clamp((r.left - bounds.left) / bounds.width, 0, 1);
    const y = clamp((r.top - bounds.top) / bounds.height, 0, 1);
    const width = clamp((r.right - bounds.left) / bounds.width, 0, 1) - x;
    const height = clamp((r.bottom - bounds.top) / bounds.height, 0, 1) - y;
    return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
  });
  const text = selection.toString().trim();
  return text && rects.length ? { rects, text } : null;
}

function readLocalDraft(key: string): AnnotationDraft | null {
  const value = localStorage.getItem(key);
  if (!value) return null;
  const draft = JSON.parse(value) as AnnotationDraft;
  if (!Array.isArray(draft?.annotations) || (draft.expectedRevision !== null && typeof draft.expectedRevision !== "string") ||
      !draft.annotations.every((a) => a && typeof a.id === "string" && a.kind in annotationLabels &&
        Number.isInteger(a.page) && typeof a.text === "string" && typeof a.comment === "string" &&
        Array.isArray(a.rects) && a.rects.every((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite)))) {
    throw new Error("本机 PDF 标注草稿格式无效");
  }
  return draft;
}

export function PdfViewer({ path, initialPage, scope, onClose, onBlockClose }: {
  path: string; initialPage: number; scope: string; onClose: () => void; onBlockClose: (blocked: boolean) => void;
}) {
  const { api, kind } = useWorkspaceRuntime();
  const [documentData, setDocumentData] = useState<OpenDocument | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pageReady, setPageReady] = useState(false);
  const [textReady, setTextReady] = useState(false);
  const [saved, setSaved] = useState<PdfAnnotations | null>(null);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [comment, setComment] = useState<Comment | null>(null);
  const [placingNote, setPlacingNote] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pageError, setPageError] = useState("");
  const [annotationError, setAnnotationError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const reading = useRef<HTMLDivElement>(null);
  const savingNow = useRef(false);
  const title = path.split("/").at(-1) ?? path;
  const draftKey = documentData ? `noto:pdf-draft:${JSON.stringify([scope, documentData.version])}` : "";
  const annotations = draft?.annotations ?? saved?.annotations ?? emptyAnnotations;
  const canAnnotate = !!saved && !!api.savePdfAnnotations && !saving;

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const blocked = saving || !!(draft && draftError) || !!comment?.value.trim();
    onBlockClose(blocked);
    return () => onBlockClose(false);
  }, [draft, draftError, comment, saving, onBlockClose]);

  useEffect(() => {
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    async function open() {
      if (!api.readPdf) throw new Error("当前工作区无法读取 PDF");
      const [file, library] = await Promise.all([api.readPdf(path, controller.signal), import("pdfjs-dist")]);
      if (controller.signal.aborted) return;
      task = createPdfTask(library, file.data, maxCanvasPixels * 4);
      const pdf = await task.promise;
      if (controller.signal.aborted) return;
      const firstPage = clamp(Number.isSafeInteger(initialPage) ? initialPage : 1, 1, pdf.numPages);
      const firstSheet = await pdf.getPage(firstPage);
      if (controller.signal.aborted) return;
      if (reading.current?.clientWidth) {
        setScale(clamp((reading.current.clientWidth - readingPadding) / firstSheet.getViewport({ scale: 1 }).width, 0.25, 1));
      }
      setPage(firstPage); setPageInput(String(firstPage));
      setDocumentData({ pdf, library, version: file.version });
    }
    void open().catch((cause) => {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { controller.abort(); void task?.destroy().catch(() => {}); };
  }, [api, path, initialPage]);

  useEffect(() => {
    if (!documentData || !api.readPdfAnnotations) return;
    let active = true;
    setAnnotationError("");
    void api.readPdfAnnotations(documentData.version).then((snapshot) => {
      if (!active) return;
      setSaved(snapshot);
      try {
        const cached = readLocalDraft(draftKey);
        if (cached && JSON.stringify(cached.annotations) !== JSON.stringify(snapshot.annotations)) {
          setDraft(cached);
          setNotice("已恢复本机未保存的 PDF 标注");
          if (cached.expectedRevision !== snapshot.revision) setAnnotationError("标注已被另一端修改。本机草稿可复制，保存时会检查版本。");
        } else { setDraft(null); }
      } catch (error) { setDraftError(String(error)); }
    }, (cause) => { if (active) setAnnotationError(`无法读取标注：${String(cause)}`); });
    return () => { active = false; };
  }, [api, documentData, draftKey, reload]);

  useEffect(() => {
    const target = surface.current;
    if (!documentData || !target) return;
    let active = true;
    let task: RenderTask | undefined;
    let text: TextLayer | undefined;
    setPageReady(false); setTextReady(false); setPageError("");
    async function render() {
      if (!documentData || !target) return;
      const sheet = await documentData.pdf.getPage(page);
      if (!active) return;
      const viewport = sheet.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(maxCanvasPixels / (viewport.width * viewport.height)));
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const layer = window.document.createElement("div");
      layer.className = "pdf-text-layer";
      layer.style.setProperty("--total-scale-factor", String(viewport.scale * sheet.userUnit));
      target.replaceChildren(canvas, layer);
      setSize({ width: viewport.width, height: viewport.height });
      task = sheet.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await task.promise;
      if (!active) return;
      setPageReady(true);
      text = new documentData.library.TextLayer({ container: layer, viewport, textContentSource: sheet.streamTextContent() });
      await text.render();
      if (active) setTextReady(true);
    }
    void render().catch((cause) => { if (active) setPageError(`页面读取失败：${String(cause)}`); });
    return () => { active = false; task?.cancel(); text?.cancel(); target.replaceChildren(); };
  }, [documentData, page, scale]);

  function edit(next: PdfAnnotation[]) {
    if (!saved) return;
    const pending = { expectedRevision: draft ? draft.expectedRevision : saved.revision, annotations: next };
    setDraft(pending); setNotice("");
    try { localStorage.setItem(draftKey, JSON.stringify(pending)); setDraftError(""); }
    catch { setDraftError("本机标注草稿写入失败，请先保存标注再关闭。"); }
  }

  async function save() {
    if (!draft || !documentData || !api.savePdfAnnotations || savingNow.current) return;
    savingNow.current = true; setSaving(true); setAnnotationError("");
    try {
      const updated = await api.savePdfAnnotations(path, { ...draft, documentVersion: documentData.version });
      setSaved(updated); setDraft(null); setDraftError(""); setNotice("已保存 PDF 标注");
      try { localStorage.removeItem(draftKey); } catch { /* A matching saved draft is ignored when reopening. */ }
    } catch (cause) { setAnnotationError(String(cause)); }
    finally { setSaving(false); savingNow.current = false; }
  }

  function goTo(value: number) {
    if (!documentData || !Number.isFinite(value)) return;
    const next = clamp(Math.trunc(value), 1, documentData.pdf.numPages);
    setPage(next); setPageInput(String(next)); setPlacingNote(false);
    reading.current?.scrollTo({ top: 0, left: 0 });
  }

  function mark(kind: PdfAnnotation["kind"]) {
    const selected = selectedText(frame.current);
    if (selected && (selected.rects.length > 80 || new TextEncoder().encode(selected.text).length > 8192)) {
      setNotice("所选文字过多，请分段标注");
      return;
    }
    if (kind === "note") {
      if (selected) setComment({ ...selected, value: "" });
      else setPlacingNote(true);
    } else if (!selected) { setNotice("请先在 PDF 页面选中文字"); return; }
    else edit([...annotations, { ...selected, id: annotationId(), page, kind, comment: "" }]);
    window.getSelection()?.removeAllRanges();
  }

  function placeNote(event: MouseEvent<HTMLDivElement>) {
    if (!placingNote || !frame.current || !pageReady) return;
    const bounds = frame.current.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 0.98);
    const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 0.98);
    setComment({ rects: [{ x, y, width: 0.02, height: 0.02 }], text: "", value: "" });
    setPlacingNote(false);
  }

  function addComment() {
    if (!comment?.value.trim()) return;
    if (comment.id) edit(annotations.map((a) => a.id === comment.id ? { ...a, comment: comment.value.trim() } : a));
    else edit([...annotations, { id: annotationId(), page, kind: "note", rects: comment.rects, text: comment.text, comment: comment.value.trim() }]);
    setComment(null);
  }

  function close() {
    if (savingNow.current) return;
    if ((draft && draftError) || comment?.value.trim()) { setConfirmClose(true); return; }
    onClose();
  }

  function discardDraft() {
    try { localStorage.removeItem(draftKey); setDraftError(""); }
    catch { setDraftError("无法清理本机标注草稿"); return; }
    setDraft(null); setComment(null); setNotice(""); setAnnotationError(""); setReload((value) => value + 1);
  }

  const pageNotes = annotations.filter((annotation) => annotation.page === page);
  return <div className="modal-backdrop pdf-viewer-backdrop"><div className="pdf-viewer" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="PDF 阅读与标注" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)") ?? []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && first && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && last && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="pdf-toolbar"><strong title={path}>{title}</strong>
      <button type="button" onClick={() => goTo(page - 1)} disabled={page <= 1 || !!comment}>上一页</button>
      <form onSubmit={(event) => { event.preventDefault(); goTo(Number(pageInput)); }}><input aria-label="跳转到 PDF 页码" type="number" min={1} max={documentData?.pdf.numPages} value={pageInput} onChange={(event) => setPageInput(event.target.value)} disabled={!documentData || !!comment} /><span> / {documentData?.pdf.numPages ?? "–"}</span></form>
      <button type="button" onClick={() => goTo(page + 1)} disabled={!documentData || page >= documentData.pdf.numPages || !!comment}>下一页</button>
      <button type="button" aria-label="缩小 PDF" disabled={scale <= 0.25} onClick={() => setScale((value) => clamp(value - 0.25, 0.25, 3))}>−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button type="button" aria-label="放大 PDF" disabled={scale >= 3} onClick={() => setScale((value) => clamp(value + 0.25, 0.25, 3))}>＋</button>
      <button type="button" disabled={!size.width} onClick={() => {
        if (reading.current) setScale(clamp((reading.current.clientWidth - readingPadding) / (size.width / scale), 0.25, 3));
      }}>适应宽度</button>
      <button type="button" onClick={() => void api.openItem(path).catch((cause) => setNotice(String(cause)))}>{kind === "web" ? "下载原件" : "系统打开"}</button>
      <button type="button" onClick={close} disabled={saving}>关闭</button>
    </header>
    <div className="pdf-workspace">
      <div className="pdf-reading" ref={reading}>
        {loadError || pageError ? <p role="alert">{loadError || pageError}</p> : !pageReady && <p role="status">正在读取 PDF…</p>}
        <div ref={frame} className={`pdf-page${placingNote ? " pdf-placing-note" : ""}`} style={size} onClick={placeNote}>
          <div ref={surface} />
          {pageReady && <div aria-hidden="true" className="pdf-mark-layer">{pageNotes.flatMap((annotation) => annotation.rects.map((r, index) => <span key={`${annotation.id}-${index}`} className={`pdf-mark-${annotation.kind}`} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` }} />))}</div>}
        </div>
      </div>
      <aside className="pdf-annotations" aria-label="PDF 标注">
        <div className="pdf-annotation-tools">
          <button disabled={!canAnnotate || !textReady || !!comment} onMouseDown={(event) => event.preventDefault()} onClick={() => mark("highlight")}>高亮</button>
          <button disabled={!canAnnotate || !textReady || !!comment} onMouseDown={(event) => event.preventDefault()} onClick={() => mark("underline")}>下划线</button>
          <button disabled={!canAnnotate || !pageReady || !!comment} onMouseDown={(event) => event.preventDefault()} onClick={() => mark("note")}>文字批注</button>
        </div>
        {placingNote && <p role="status">点击 PDF 页面放置批注。<button onClick={() => setPlacingNote(false)}>取消</button></p>}
        {comment && <form className="pdf-comment" onSubmit={(event) => { event.preventDefault(); addComment(); }}>
          {comment.text && <blockquote>{comment.text}</blockquote>}
          <textarea aria-label="文字批注内容" value={comment.value} onChange={(event) => setComment({ ...comment, value: event.target.value })} maxLength={2600} autoFocus />
          <button type="submit" disabled={!comment.value.trim()}>确认批注</button> <button type="button" onClick={() => setComment(null)}>取消</button>
        </form>}
        {(annotationError || draftError) && <p role="alert">{annotationError || draftError}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="pdf-annotation-tools">
          <button className="primary" disabled={!draft || saving || !!comment || !api.savePdfAnnotations} onClick={() => void save()}>{saving ? "保存中…" : "保存标注"}</button>
          <button disabled={!annotations.length} onClick={() => void copyText(annotations.map((a) => `- 第 ${a.page} 页 · ${annotationLabels[a.kind]}：${[a.text, a.comment].filter(Boolean).join(" — ")}`).join("\n")).then((ok) => { if (ok) setNotice("已复制带页码的标注"); })}>复制为 Markdown</button>
          {annotationError && <button disabled={saving} onClick={() => {
            if (!draft) setReload((value) => value + 1);
            else if (window.confirm("重新载入已保存的标注，并丢弃本机未保存的标注？")) discardDraft();
          }}>重新载入标注</button>}
        </div>
        <p>{draft ? "标注有未保存的修改" : `第 ${page} 页 · ${pageNotes.length} 条标注`}</p>
        <ul>{pageNotes.map((annotation) => <li key={annotation.id}>
          <strong>{annotationLabels[annotation.kind]}</strong>
          {annotation.text && <blockquote>{annotation.text}</blockquote>}
          {annotation.comment && <p>{annotation.comment}</p>}
          {annotation.kind === "note" && <button disabled={!canAnnotate || !!comment} onClick={() => setComment({ id: annotation.id, rects: annotation.rects, text: annotation.text, value: annotation.comment })}>编辑</button>}
          <button disabled={!canAnnotate || !!comment} onClick={() => edit(annotations.filter((entry) => entry.id !== annotation.id))}>删除</button>
        </li>)}</ul>
        {confirmClose && <div role="alert"><p>仍有无法自动保留的输入。</p><button onClick={() => setConfirmClose(false)}>继续编辑</button> <button onClick={onClose}>关闭并放弃该输入</button></div>}
      </aside>
    </div>
  </div></div>;
}
