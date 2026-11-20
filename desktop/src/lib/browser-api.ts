import { WorkspaceError, isTransient, type ErrorCode } from "./api-error";
import { BrowserStore } from "./browser-store";
import type {WebDavConfig,WebDavInput,WebDavReport} from "./vault-api";
import { RelocationError, remapPath, rewriteDocumentLinks } from "./relocate-notes";
import type { Draft, Entry, Note, RelocationPlan, RelocationResult, TrashItem, WorkspaceApi, HistoryEntry, HistorySnapshot, NoteActivityDay, PdfDocument, PdfAnnotationUpdate, PdfAnnotations, StorageDiagnostics } from "./vault-api";

export interface WebIdentity { serverId: string; vaultId: string; vault: string; csrf: string }
interface Operation {
  id: string; status: "queued" | "running" | "completed" | "failed" | "interrupted";
  completedMoves: RelocationPlan["moves"]; notes: Note[]; backup: string; message: string | null;
  pendingMove: RelocationPlan["moves"][number] | null;
}
interface PendingOperation { id: string; plan: RelocationPlan; originals: Note[]; drafts: Draft[] }
interface WriteSnapshot { content: string; baseVersion: string; draftKey?: string }

export async function http<T>(url: string, options: RequestInit = {}, csrf?: string, authRequired?: () => void, timeoutMs=20000): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  if (csrf) headers.set("x-noto-csrf", csrf);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, { ...options, headers, signal, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new WorkspaceError(body.code ?? (response.status === 401 ? "unauthorized" : "storage") as ErrorCode, body.message ?? `请求失败（${response.status}）`);
      if (["unauthorized", "csrf"].includes(error.code)) authRequired?.();
      throw error;
    }
    return response.status === 204 ? undefined as T : await response.json();
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("network", "无法连接网页服务，编辑已留在本机；连接恢复后会重新检查文件版本");
  } finally { clearTimeout(timeout); }
}
function id() {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
const query = (path: string) => `?path=${encodeURIComponent(path)}`;
const attachmentQuery = (note: string, link: string) => `?note=${encodeURIComponent(note)}&link=${encodeURIComponent(link)}`;

export class BrowserApi implements WorkspaceApi {
  readonly store: BrowserStore;
  private files = new Map<string, File>();
  private recovered?: (result: RelocationResult, incomplete: boolean) => Promise<void>;
  private writer = id();
  private selectedDrafts = new Map<string, Draft>();
  private cache = new Map<string, Note>();
  private draftKey = (path: string) => `draft:${this.writer}:${path}`;
  private writeKey = (path: string) => `write:${this.writer}:${path}`;
  constructor(public identity: WebIdentity, private authRequired: () => void, store?: BrowserStore) {
    this.store = store ?? new BrowserStore(`${location.origin}|${identity.serverId}|${identity.vaultId}|owner`);
  }
  request = <T,>(url: string, options: RequestInit = {}) => http<T>(url, options, this.identity.csrf, this.authRequired);
  status = async () => ({ vault: this.identity.vault, error: null, id: this.store.scope });
  entries = () => this.request<Entry[]>("/api/entries");
  storageDiagnostics = () => this.request<StorageDiagnostics>("/api/storage-diagnostics", { method: "POST" });
  read = (path: string) => this.request<Note>(`/api/note${query(path)}`);
  readPdf = (path: string, signal?: AbortSignal) => http<PdfDocument>(`/api/pdf${query(path)}`, { signal }, this.identity.csrf, this.authRequired, 90000);
  readSearchText = (path: string, signal?: AbortSignal) => this.request<string>(`/api/search-text${query(path)}`, { signal });
  readPdfAnnotations = (version: string) => this.request<PdfAnnotations>(`/api/pdf/annotations?version=${encodeURIComponent(version)}`);
  savePdfAnnotations = (path: string, update: PdfAnnotationUpdate) => this.request<PdfAnnotations>(`/api/pdf/annotations${query(path)}`, { method: "PUT", body: JSON.stringify(update) });
  webdavTest = (config:WebDavConfig)=>http<void>("/api/webdav/test",{method:"POST",body:JSON.stringify(config)},this.identity.csrf,this.authRequired,45000);
  webdavSync = (input:WebDavInput)=>http<WebDavReport>("/api/webdav/sync",{method:"POST",body:JSON.stringify(input)},this.identity.csrf,this.authRequired,360000);
  fileHistory = (path:string) => this.request<HistoryEntry[]>(`/api/history${query(path)}`);
  noteActivity = (dayStarts: number[]) => this.request<NoteActivityDay[]>("/api/note-activity", { method: "POST", body: JSON.stringify({ dayStarts }) });
  readHistory = (path:string,id:string) => this.request<HistorySnapshot>(`/api/history/content${query(path)}&id=${encodeURIComponent(id)}`);
  checkpointHistory = (path:string,content:string,expectedVersion:string) => this.request<void>("/api/history/checkpoint", {method:"POST",body:JSON.stringify({path,content,expectedVersion})});
  snapshot = async (paths: string[], signal?: AbortSignal) => {
    const notes: Note[] = [], errors: { path: string; error: string }[] = [];
    const readBatch = async (batch: string[]) => {
      signal?.throwIfAborted();
      const previous = new Map(batch.map(path => [path, this.cache.get(path)]));
      const result = await this.request<{ notes: Note[]; unchanged: string[]; errors: { path: string; error: string }[] }>("/api/snapshot", {
        method: "POST", signal, body: JSON.stringify({ notes: batch.map(path => ({ path, version: previous.get(path)?.version ?? "" })) }),
      });
      signal?.throwIfAborted();
      const found = new Map(result.notes.map(note => [note.path, note]));
      for (const path of result.unchanged) {
        const note = previous.get(path);
        if (note) found.set(path, note);
      }
      const ordered = batch.flatMap(path => {
        const note = found.get(path);
        if (this.cache.get(path) === previous.get(path)) {
          if (note) this.cache.set(path, note);
          else this.cache.delete(path);
        }
        return note ? [note] : [];
      });
      return { notes: ordered, errors: result.errors };
    };
    const pageSize = 32, parallelPages = 4;
    for (let start = 0; start < paths.length; start += pageSize * parallelPages) {
      const requests = [];
      for (let offset = start; offset < Math.min(paths.length, start + pageSize * parallelPages); offset += pageSize) {
        requests.push(readBatch(paths.slice(offset, offset + pageSize)));
      }
      for (const batch of await Promise.all(requests)) {
        notes.push(...batch.notes);
        errors.push(...batch.errors);
      }
    }
    return { notes, errors };
  };
  save = async (path: string, content: string, expectedVersion: string) => {
    const previous = await this.store.get<WriteSnapshot>(this.writeKey(path));
    if (previous?.baseVersion === expectedVersion) {
      const disk = await this.read(path);
      if (disk.content === previous.content) expectedVersion = disk.version;
      else if (disk.version !== expectedVersion) throw new WorkspaceError("conflict", "服务端文件已变化，当前编辑和本机草稿已保留");
    }
    await this.store.put(this.writeKey(path), { content, baseVersion: expectedVersion, draftKey: this.draftKey(path) });
    try {
      const saved = await this.request<Note>(`/api/note${query(path)}`, { method: "PUT", body: JSON.stringify({ content, expectedVersion }) });
      await this.store.remove(this.writeKey(path)).catch(() => {}); return saved;
    }
    catch (error) {
      if (isTransient(error) || (error instanceof WorkspaceError && error.code === "conflict")) {
        // A write may have completed while its response was lost. Confirm the
        // saved snapshot before rebasing any subsequent input.
        const disk = await this.read(path).catch(() => null);
        if (disk?.content === content.replace(/\r\n?/g, "\n")) { await this.store.remove(this.writeKey(path)).catch(() => {}); return disk; }
        if (disk && disk.version !== expectedVersion) throw new WorkspaceError("conflict", "服务端文件已变化，当前编辑和本机草稿已保留");
      }
      throw error;
    }
  };
  createNote = (path: string, content = "") => this.request<Note>("/api/note", { method: "POST", body: JSON.stringify({ path, content }) });
  createDirectory = (path: string) => this.request<void>("/api/directory", { method: "POST", body: JSON.stringify({ path }) });
  move = async () => { throw new WorkspaceError("unsupported", "网页端目录调整必须使用可恢复的操作计划"); };
  remove = (path: string) => this.request<void>(`/api/item${query(path)}`, { method: "DELETE" });
  image = (note: string, link: string) => this.request<string>(`/api/image${attachmentQuery(note, link)}`);
  confirmSaved = async (path: string, baseVersion: string, disk: Note) => {
    const pending = await this.store.get<WriteSnapshot>(this.writeKey(path));
    if (pending?.baseVersion !== baseVersion || disk.content !== pending.content) return false;
    return this.store.rebaseDraft(this.draftKey(path), baseVersion, disk.version, this.writeKey(path), pending);
  };
  drafts = async () => {
    const drafts = (await this.store.records<Draft>("draft:")).map(({ key, value }) => ({ ...value, recoveryId: key }));
    for (const draft of drafts) {
      const key = draft.recoveryId ? `write:${draft.recoveryId.slice(6)}` : `write:${draft.path}`;
      const pending = await this.store.get<WriteSnapshot>(key);
      if (pending?.baseVersion === draft.baseVersion) {
        const disk = await this.read(draft.path).catch(() => null);
        if (disk?.content === pending.content) {
          if (await this.store.rebaseDraft(draft.recoveryId, draft.baseVersion, disk.version, key, pending)) draft.baseVersion = disk.version;
        }
      }
    }
    return drafts;
  };
  writeDraft = async (draft: Draft) => {
    draft.recoveryId = this.draftKey(draft.path);
    await this.store.put(draft.recoveryId, draft);
  };
  selectDraft = (draft: Draft) => { this.selectedDrafts.set(draft.path, { ...draft }); };
  removeDraft = async (path: string) => {
    await this.store.remove(this.draftKey(path));
    await this.store.remove(this.writeKey(path));
    const selected = this.selectedDrafts.get(path);
    if (selected) { await this.store.removeIfUnchanged(selected.recoveryId ?? `draft:${path}`, selected); this.selectedDrafts.delete(path); }
  };
  trash = () => this.request<TrashItem[]>("/api/trash");
  restore = (item: string) => this.request<void>(`/api/trash/${encodeURIComponent(item)}/restore`, { method: "POST" });
  selectVault = async () => { throw new WorkspaceError("unsupported", "网页知识库由部署配置指定"); };
  createVault = this.selectVault;
  chooseDirectory = async () => { throw new WorkspaceError("unsupported", "网页不能选择服务器目录，请修改部署配置"); };
  chooseFile = (): Promise<string | null> => new Promise((resolve) => {
    const input = document.createElement("input"); input.type = "file";
    input.onchange = () => { const file = input.files?.[0]; if (!file) { resolve(null); return; } const key = id(); this.files.set(key, file); resolve(key); };
    input.oncancel = () => resolve(null);
    input.click();
  });
  importAttachment = async (note: string, source: string) => {
    const file = this.files.get(source);
    if (!file) throw new WorkspaceError("not_found", "请重新选择要上传的附件");
    if (file.size > 63 * 1024 * 1024) throw new WorkspaceError("unsupported", "附件超过上传上限（63 MB）");
    const body = new FormData(); body.append("file", file);
    try { return await this.request<string>(`/api/attachment${query(note)}`, { method: "POST", body }); }
    finally { this.files.delete(source); }
  };
  importAttachmentData = async (note: string, name: string, bytes: Uint8Array) => {
    if (bytes.length > 16 * 1024 * 1024) throw new WorkspaceError("unsupported", "图片粘贴或拖入上限为 16 MB，请使用导入附件");
    const body = new FormData(); body.append("file", new Blob([new Uint8Array(bytes).buffer]), name);
    return this.request<string>(`/api/attachment${query(note)}`, { method: "POST", body });
  };
  openAttachment = async (note: string, link: string) => {
    // Check the session before handing off to a streaming download. Its URL
    // contains paths only; credentials stay in the HttpOnly cookie.
    await this.request<WebIdentity>("/api/session");
    const anchor = document.createElement("a"); anchor.href = `/api/attachment${attachmentQuery(note, link)}`; anchor.download = ""; anchor.click();
  };
  openItem = (path: string) => this.openAttachment(path, path.split("/").at(-1)!);
  openExternal = async (url: string) => { if (!/^(?:https?:|mailto:)/i.test(url)) throw new WorkspaceError("invalid_path", "不支持的外部链接"); window.open(url, "_blank", "noopener,noreferrer"); };

  private async waitOperation(operation: string): Promise<Operation> {
    for (;;) {
      const result = await this.request<Operation>(`/api/operations/${operation}`);
      if (! ["running", "queued"].includes(result.status)) return result;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  private async applyOperation(pending: PendingOperation, operation: Operation): Promise<RelocationResult> {
    const moves = operation.completedMoves;
    const paths = pending.originals.map((note) => note.path);
    const updates: { oldKey: string; original: Draft; key: string; draft: Draft }[] = [];
    for (const draft of pending.drafts) {
      const target = remapPath(draft.path, moves);
      const content = rewriteDocumentLinks(draft.content, draft.path, target, moves, paths);
      const saved = operation.notes.find((note) => note.path === target);
      const original = pending.originals.find((note) => note.path === draft.path);
      // An incomplete move can have rewritten only some files. Require explicit
      // recovery instead of automatically saving potentially stale links.
      const baseVersion = operation.status !== "completed" ? `incomplete:${draft.baseVersion}` : saved && original?.version === draft.baseVersion ? saved.version : draft.baseVersion;
      if (target === draft.path && content === draft.content && baseVersion === draft.baseVersion) continue;
      const key = `draft:${pending.id}:${updates.length}:${target}`;
      const migrated = { path: target, content, baseVersion, recoveryId: key };
      updates.push({ oldKey: draft.recoveryId ?? `draft:${draft.path}`, original: draft, key, draft: migrated });
      this.selectedDrafts.set(target, migrated);
    }
    // Preserve the pre-operation drafts until their new paths AND the operation
    // receipt have committed together. Reopening can safely run this again.
    await this.store.migrateDrafts(updates, [{ key: `receipt:${pending.id}`, value: operation }], [`operation:${pending.id}`]);
    return { moves, notes: operation.notes, originals: pending.originals, backup: operation.backup };
  }
  relocate = async (plan: RelocationPlan, originals: Note[]): Promise<RelocationResult> => {
    const existing = await this.store.records<PendingOperation>("operation:");
    if (existing.length) throw new WorkspaceError("operation_pending", "有待确认的目录操作，请重新打开页面查询结果后再继续");
    const pending = { id: id(), plan, originals, drafts: await this.drafts() };
    await this.store.put(`operation:${pending.id}`, pending);
    await this.request<Operation>(`/api/operations/${pending.id}`, { method: "POST", body: JSON.stringify(plan) });
    const operation = await this.waitOperation(pending.id);
    const result = await this.applyOperation(pending, operation);
    if (operation.status !== "completed") throw new RelocationError(`${operation.message ?? "目录调整未完成"}。操作 ${pending.id}，备份：${operation.backup}${operation.pendingMove ? `；待确认：${operation.pendingMove.from} → ${operation.pendingMove.to}` : ""}`, operation.backup, operation.completedMoves, originals);
    return result;
  };
  onRelocationRecovered = (handler: (result: RelocationResult, incomplete: boolean) => Promise<void>) => {
    this.recovered = handler; return () => { if (this.recovered === handler) this.recovered = undefined; };
  };
  async resumeOperations(report: (message: string) => void) {
    for (const { value: pending } of await this.store.records<PendingOperation>("operation:")) {
      report(`正在确认目录操作 ${pending.id}…`);
      let operation: Operation;
      try { operation = await this.waitOperation(pending.id); }
      catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "not_found") throw error;
        // Only a definitive 404 allows submission with the SAME durable id.
        await this.request<Operation>(`/api/operations/${pending.id}`, { method: "POST", body: JSON.stringify(pending.plan) });
        operation = await this.waitOperation(pending.id);
      }
      const result = await this.applyOperation(pending, operation);
      await this.recovered?.(result, operation.status !== "completed");
      report(operation.status === "completed" ? "已确认上次目录操作并恢复本机草稿路径。" : `目录操作未完成：${operation.message}；备份：${operation.backup}。请核对实际文件位置并处理恢复草稿。`);
    }
  }
}
