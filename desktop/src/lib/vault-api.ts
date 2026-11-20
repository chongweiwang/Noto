// Shared file contract. Desktop IPC and the phase-2 HTTP adapter implement the
// same operations; native dialogs/window actions stay in the platform contract.
export interface Note { path: string; content: string; version: string }
export interface Entry { path: string; name: string; isDirectory: boolean; children: Entry[]; issue?: string }
export interface Draft { path: string; content: string; baseVersion: string; recoveryId?: string }
export interface VaultStatus { vault: string | null; error: string | null; id?: string }
export type StorageCheckStatus = "ok" | "missing" | "notDirectory" | "permissionDenied" | "readOnly" | "storageFull" | "cleanupFailed" | "failed";
export interface StorageDirectory { path: string; read: StorageCheckStatus; write: StorageCheckStatus }
export interface StorageDiagnostics { vault: StorageDirectory | null; data: StorageDirectory }
export interface PathMove { from: string; to: string }
export interface RelocationPlan {
  moves: PathMove[];
  edits: { path: string; target: string; content: string; expectedVersion: string }[];
  checks: { path: string; version: string }[];
}
export interface RelocationResult { moves: PathMove[]; notes: Note[]; originals: Note[]; backup: string | null }
export interface TrashItem { id: string; path: string; deletedAt: number; isDirectory: boolean; status: string }
export interface HistoryEntry { id: string; createdAt: number; size: number; reason: "save" | "restore" }
export interface HistorySnapshot extends HistoryEntry { content: string }
export interface NoteActivityDay { created: number; edited: number }
export interface PdfDocument { data: string; version: string }
export interface PdfRect { x: number; y: number; width: number; height: number }
export interface PdfAnnotation { id: string; page: number; kind: "highlight" | "underline" | "note"; rects: PdfRect[]; text: string; comment: string }
export interface PdfAnnotations { revision: string | null; annotations: PdfAnnotation[] }
export interface PdfAnnotationUpdate { documentVersion: string; expectedRevision: string | null; annotations: PdfAnnotation[] }
export interface WebDavConfig {url:string;username:string;password:string;remotePath:string}
export interface SyncConflict {path:string;reason:string;localVersion:string|null;remoteVersion:string|null;copy:string|null}
export interface SyncResolution {path:string;localVersion:string|null;remoteVersion:string|null;choice:"local"|"remote"}
export interface WebDavReport {uploaded:number;downloaded:number;deletedLocal:number;deletedRemote:number;conflicts:SyncConflict[];skipped:string[];errors:{path:string;message:string}[];changed:string[]}
export interface WebDavInput {config:WebDavConfig;protectedPaths:string[];resolutions:SyncResolution[]}

export interface VaultApi {
  storageDiagnostics?: () => Promise<StorageDiagnostics>;
  readPdf?: (path: string, signal?: AbortSignal) => Promise<PdfDocument>;
  readSearchText?: (path: string, signal?: AbortSignal) => Promise<string>;
  readPdfAnnotations?: (version: string) => Promise<PdfAnnotations>;
  savePdfAnnotations?: (path: string, update: PdfAnnotationUpdate) => Promise<PdfAnnotations>;
  webdavTest?: (config:WebDavConfig)=>Promise<void>;
  webdavSync?: (input:WebDavInput)=>Promise<WebDavReport>;
  fileHistory?: (path: string) => Promise<HistoryEntry[]>;
  noteActivity?: (dayStarts: number[]) => Promise<NoteActivityDay[]>;
  readHistory?: (path: string, id: string) => Promise<HistorySnapshot>;
  checkpointHistory?: (path: string, content: string, expectedVersion: string) => Promise<void>;
  backupDocument?: (path:string,backupRoot:string,expectedVersion:string)=>Promise<void>;
  importAttachmentData?: (note: string, name: string, bytes: Uint8Array) => Promise<string>;
  entries: () => Promise<Entry[]>;
  snapshot?: (paths: string[], signal?: AbortSignal) => Promise<{ notes: Note[]; errors: { path: string; error: string }[] }>;
  read: (path: string) => Promise<Note>;
  save: (path: string, content: string, expectedVersion: string) => Promise<Note>;
  createNote: (path: string, content?: string) => Promise<Note>;
  createDirectory: (path: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  image: (note: string, link: string) => Promise<string>;
  drafts: () => Promise<Draft[]>;
  writeDraft: (draft: Draft) => Promise<void>;
  removeDraft: (path: string) => Promise<void>;
  relocate?: (plan: RelocationPlan, originals: Note[]) => Promise<RelocationResult>;
  trash?: () => Promise<TrashItem[]>;
  restore?: (id: string) => Promise<void>;
  confirmSaved?: (path: string, baseVersion: string, disk: Note) => Promise<boolean>;
  onRelocationRecovered?: (handler: (result: RelocationResult, incomplete: boolean) => Promise<void>) => () => void;
  selectDraft?: (draft: Draft) => void;
}

export interface PlatformApi {
  status: () => Promise<VaultStatus>;
  selectVault: (path: string) => Promise<VaultStatus>;
  createVault: (parent: string, name: string) => Promise<VaultStatus>;
  chooseDirectory: () => Promise<string | string[] | null>;
  chooseFile: () => Promise<string | string[] | null>;
  importAttachment: (note: string, source: string) => Promise<string>;
  openAttachment: (note: string, link: string) => Promise<void>;
  openItem: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
}

export type WorkspaceApi = VaultApi & PlatformApi;
