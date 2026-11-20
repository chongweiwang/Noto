import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {WebDavConfig,WebDavInput,WebDavReport} from "./vault-api";
import type { Draft, Entry, Note, VaultStatus, WorkspaceApi, HistoryEntry, HistorySnapshot, NoteActivityDay, PdfDocument, PdfAnnotationUpdate, PdfAnnotations, StorageDiagnostics } from "./vault-api";
import { WorkspaceError, type ErrorCode } from "./api-error";

async function nativeCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); }
  catch (cause) {
    const message = String(cause);
    const code: ErrorCode = /外部修改|版本|冲突/.test(message) ? "conflict" : /不存在|已被删除|系统找不到指定|No such file or directory|os error [23]\)/.test(message) ? "not_found" : /目标已存在/.test(message) ? "already_exists" : /路径无效|超出知识库/.test(message) ? "invalid_path" : /拒绝访问|Permission denied|只读/.test(message) ? "permission" : /UTF-8|换行符/.test(message) ? "encoding" : "storage";
    throw new WorkspaceError(code, message);
  }
}

export type { Draft, Entry, Note, VaultStatus } from "./vault-api";

export const desktop = {
  readPdf: (path: string) => nativeCall<PdfDocument>("read_pdf", { path }),
  readSearchText: (path: string) => nativeCall<string>("read_search_text", { path }),
  readPdfAnnotations: (version: string) => nativeCall<PdfAnnotations>("read_pdf_annotations", { version }),
  savePdfAnnotations: (path: string, update: PdfAnnotationUpdate) => nativeCall<PdfAnnotations>("save_pdf_annotations", { path, update }),
  webdavTest:(config:WebDavConfig)=>nativeCall<void>("webdav_test",{config}),
  webdavSync:(input:WebDavInput)=>nativeCall<WebDavReport>("webdav_sync",{input}),
  fileHistory: (path:string) => nativeCall<HistoryEntry[]>("file_history", {path}),
  noteActivity: (dayStarts: number[]) => nativeCall<NoteActivityDay[]>("note_activity", { dayStarts }),
  readHistory: (path:string,id:string) => nativeCall<HistorySnapshot>("read_history", {path,id}),
  checkpointHistory: (path:string,content:string,expectedVersion:string) => nativeCall<void>("checkpoint_history", {path,content,expectedVersion}),
  backupDocument:(path:string,backupRoot:string,expectedVersion:string)=>nativeCall<void>("backup_document",{path,backupRoot,expectedVersion}),
  status: () => nativeCall<VaultStatus>("status"),
  storageDiagnostics: () => nativeCall<StorageDiagnostics>("storage_diagnostics"),
  selectVault: (path: string) => nativeCall<VaultStatus>("select_vault", { path }),
  createVault: (parent: string, name: string) => nativeCall<VaultStatus>("create_vault", { parent, name }),
  entries: () => nativeCall<Entry[]>("list_entries"),
  read: (path: string) => nativeCall<Note>("read_note", { path }),
  save: (path: string, content: string, expectedVersion: string) =>
    nativeCall<Note>("save_note", { path, content, expectedVersion }),
  createNote: (path: string, content = "") => nativeCall<Note>("create_note", { path, content }),
  createDirectory: (path: string) => nativeCall<void>("create_directory", { path }),
  move: (from: string, to: string) => nativeCall<void>("move_item", { from, to }),
  remove: (path: string) => nativeCall<void>("delete_item", { path }),
  importAttachment: (note: string, source: string) => nativeCall<string>("import_attachment", { note, source }),
  importAttachmentData: (note: string, name: string, bytes: Uint8Array) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return nativeCall<string>("import_attachment_data", { note, name, data: btoa(binary) });
  },
  image: (note: string, link: string) => nativeCall<string>("read_image", { note, link }),
  openAttachment: (note: string, link: string) => nativeCall<void>("open_attachment", { note, link }),
  openItem: (path: string) => nativeCall<void>("open_item", { path }),
  openExternal: (url: string) => nativeCall<void>("open_external", { url }),
  drafts: () => nativeCall<Draft[]>("list_drafts"),
  writeDraft: (draft: Draft) => nativeCall<void>("write_draft", { draft }),
  removeDraft: (path: string) => nativeCall<void>("remove_draft", { path }),
  chooseDirectory: () => open({ directory: true, multiple: false, title: "选择知识库文件夹" }),
  chooseFile: () => open({ directory: false, multiple: false, title: "选择要导入的附件" }),
} satisfies WorkspaceApi;
