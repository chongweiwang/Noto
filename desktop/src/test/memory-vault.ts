import type { Draft, Note } from "../lib/desktop-api";
import { vaultEntries } from "./vault-entries";

export class MemoryVault {
  notes = new Map<string, Note>();
  folders = new Set<string>();
  stored = new Map<string, Draft>();
  serial = 0;
  put(path: string, content: string) { const note = { path, content, version: `v${++this.serial}` }; this.notes.set(path, note); return { ...note }; }
  entries = async () => vaultEntries(this.notes.keys(), this.folders);
  read = async (path: string) => { const note = this.notes.get(path); if (!note) throw new Error(`文件不存在：${path}`); return { ...note }; };
  createDirectory = async (path: string) => { if (this.folders.has(path) || this.notes.has(path)) throw new Error("目标已存在"); this.folders.add(path); };
  createNote = async (path: string, content = "") => { if (this.notes.has(path)) throw new Error("目标已存在"); return this.put(path, content); };
  save = async (path: string, content: string, version: string) => { if ((await this.read(path)).version !== version) throw new Error("外部修改"); return this.put(path, content); };
  move = async (from: string, to: string) => {
    if (this.notes.has(to) || this.folders.has(to)) throw new Error("目标已存在");
    if (this.notes.has(from)) { const note = await this.read(from); this.notes.delete(from); this.notes.set(to, { ...note, path: to }); return; }
    if (!this.folders.has(from) && ![...this.notes.keys()].some((path) => path.startsWith(`${from}/`))) throw new Error("来源不存在");
    for (const path of [...this.folders]) if (path === from || path.startsWith(`${from}/`)) { this.folders.delete(path); this.folders.add(to + path.slice(from.length)); }
    for (const [path, note] of [...this.notes]) if (path.startsWith(`${from}/`)) { const target = to + path.slice(from.length); this.notes.delete(path); this.notes.set(target, { ...note, path: target }); }
  };
  drafts = async () => [...this.stored.values()].map((draft) => ({ ...draft }));
  writeDraft = async (draft: Draft) => { this.stored.set(draft.path, { ...draft }); };
  removeDraft = async (path: string) => { this.stored.delete(path); };
}
