import {isCanvas,isDrawing,isStructuredDocument,isMarkdown,documentPaths} from "./document-kind";
import {rewriteCanvasReferences} from "./canvas-references";
import {rewriteDrawingReferences} from "./drawing-references";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { decodeString } from "micromark-util-decode-string";
import type { Note, VaultApi } from "./vault-api";
import { parseKnowledge, wikiTargetForPath } from "./knowledge";
import {resolveWikiTarget,wikiHeadingFile,wikiFileRange,encodeWikiText} from "./wiki-target";
import {parseNoteEmbeds,unsupportedEmbedFile} from "./note-embed";
import { resolveNoteLink } from "./markdown-links";
import { dailyPath } from "./calendar";
import { isTaskCategoryDocument } from "./tasks";
import { defaultTaskGroup, encodePath, ensureDirectory, findEntry, isMarkdownPath, parentPath, pathName, relativePath } from "./vault-structure";

type Node = { type: string; url?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export type NoteMove = { from: string; to: string };
export class RelocationError extends Error {
  constructor(message: string, public backup: string, public completedMoves: NoteMove[], public originals: Note[]) { super(message); }
}
export function remapPath(path: string, moves: NoteMove[]): string { const move = moves.find((item) => path === item.from || path.startsWith(`${item.from}/`)); return move ? move.to + path.slice(move.from.length) : path; }
export type RelocationApi = Pick<VaultApi, "entries" | "read" | "save" | "createDirectory" | "createNote" | "move" | "drafts" | "writeDraft" | "removeDraft" | "relocate" | "snapshot" | "backupDocument">;
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function destination(source: string, node: Node): { from: number; to: number } | null {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  if (from === undefined || to === undefined) return null;
  let at = from;
  if (node.type === "definition") {
    const match = /^\[(?:\\.|[^\]\\])+\]:\s*/.exec(source.slice(from, to));
    if (!match) return null;
    at += match[0].length;
  } else {
    at = node.children?.at(-1)?.position?.end.offset ?? from;
    at = source.indexOf("](", at);
    if (at < from || at >= to) return null;
    at += 2;
    while (/\s/.test(source[at] ?? "") && at < to) at++;
  }
  const angle = source[at] === "<";
  if (angle) at++;
  const start = at;
  let depth = 0;
  for (; at < to; at++) {
    const char = source[at];
    if (char === "\\") { at++; continue; }
    if (angle && char === ">") break;
    if (!angle) {
      if (char === "(") depth++;
      else if (char === ")") { if (!depth) break; depth--; }
      else if (/\s/.test(char) && !depth) break;
    }
  }
  return decodeString(source.slice(start, at)) === node.url ? { from: start, to: at } : null;
}

export function rewriteNoteLinks(source: string, oldPath: string, newPath: string, moves: NoteMove[], paths: string[], drawingPaths:string[]=[]): string {
  const newPaths = paths.map((path) => remapPath(path, moves));
  const edits: { from: number; to: number; value: string }[] = [];
  function visit(node: Node) {
    if (["link", "image", "definition"].includes(node.type) && node.url && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(node.url)) {
      const split = node.url.search(/[?#]/), linkPath = split < 0 ? node.url : node.url.slice(0, split), suffix = split < 0 ? "" : node.url.slice(split);
      const target = resolveNoteLink(oldPath, linkPath);
      if (target && relativePath(oldPath, target) !== relativePath(newPath, remapPath(target, moves))) {
        const range = destination(source, node);
        if (!range) throw new Error(`“${oldPath}”中有无法安全改写的链接，请先在原文中调整`);
        edits.push({ ...range, value: encodePath(relativePath(newPath, remapPath(target, moves))) + suffix });
      }
      return;
    }
    node.children?.forEach(visit);
  }
  visit(parser.parse(source) as Node);
  for (const link of [...parseKnowledge(source).wiki,...parseNoteEmbeds(source).filter(link=>!unsupportedEmbedFile(resolveWikiTarget(link.target,oldPath,paths).file)).map(link=>({...link,from:link.from+1}))]) {
    const before=resolveWikiTarget(link.target,oldPath,paths);
    if(before.candidates.length!==1||!before.file)continue;
    const target=remapPath(before.candidates[0],moves),after=resolveWikiTarget(link.target,newPath,newPaths);
    if(after.candidates.length===1&&after.candidates[0]===target&&after.fragment===before.fragment)continue;
    const file=before.fragment===null?wikiTargetForPath(target,newPaths):wikiHeadingFile(target);
    const next=resolveWikiTarget(file+(before.fragment===null?"":"#"+before.fragment),newPath,newPaths);
    if(next.candidates.length!==1||next.candidates[0]!==target||next.fragment!==before.fragment)throw new Error(`“${oldPath}”的 Wiki 目标与已有文件名冲突，无法安全改写`);
    edits.push({...wikiFileRange(source,link,before.file),value:encodeWikiText(file)});
  }
  const newDrawingPaths=drawingPaths.map(path=>remapPath(path,moves));
  for(const embed of parseNoteEmbeds(source)){
    const before=resolveWikiTarget(embed.target,oldPath,drawingPaths);
    if(before.candidates.length!==1||!isDrawing(before.candidates[0])||before.fragment!==null)continue;
    const target=remapPath(before.candidates[0],moves),after=resolveWikiTarget(embed.target,newPath,newDrawingPaths);
    if(after.candidates.length===1&&after.candidates[0]===target&&after.fragment===null)continue;
    if(target.includes("|"))throw new Error(`“${oldPath}”的白板嵌入无法安全改写`);
    const file=target.includes("/")?target:"./"+target,next=resolveWikiTarget(file,newPath,newDrawingPaths);
    if(next.candidates.length!==1||next.candidates[0]!==target||next.fragment!==null)throw new Error(`“${oldPath}”的白板嵌入无法安全改写`);
    const value=encodeWikiText(file),check=parseNoteEmbeds("![["+value+"]]")[0];
    if(!check||check.target!==file)throw new Error(`“${oldPath}”的白板嵌入无法安全改写`);
    edits.push({...wikiFileRange(source,{...embed,from:embed.from+1},before.file),value});
  }
  return edits.sort((a, b) => b.from - a.from).reduce((text, edit) => text.slice(0, edit.from) + edit.value + text.slice(edit.to), source);
}

export function rewriteDocumentLinks(source:string,oldPath:string,newPath:string,moves:NoteMove[],paths:string[]):string {
  const markdownPaths=paths.filter(isMarkdown),drawingPaths=paths.filter(isDrawing);
  const rewrite=(text:string,oldFile:string,newFile:string,changes:NoteMove[],notes:string[])=>rewriteNoteLinks(text,oldFile,newFile,changes,notes,drawingPaths);
  return isDrawing(oldPath)?rewriteDrawingReferences(source,moves):isCanvas(oldPath)?rewriteCanvasReferences(source,oldPath,newPath,moves,markdownPaths,rewrite):rewrite(source,oldPath,newPath,moves,markdownPaths);
}

// Back up affected Markdown and drafts before moving anything. All content
// writes still use the file versions read during planning.
export async function relocateNotes(moves: NoteMove[], api: RelocationApi) {
  if (!moves.length) return { moves: [], notes: [] as Note[], originals: [] as Note[], backup: null as string | null };
  const entries = await api.entries(), paths = documentPaths(entries);
  const snapshot = api.snapshot ? await api.snapshot(paths) : null;
  if (snapshot?.errors.length) throw new Error(`无法完整读取知识库，请先处理：${snapshot.errors.map((item) => item.path).join("、")}`);
  const all = snapshot?.notes ?? await Promise.all(paths.map((path) => api.read(path)));
  for (const move of moves) {
    if ([move.from, move.to].some((path) => !path || /[\\\0]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("移动路径无效，请使用知识库内的相对路径");
    if (move.to.startsWith(`${move.from}/`)) throw new Error("不能把文件夹移动到其自身内部");
    if (!findEntry(entries, move.from)) throw new Error(`迁移来源不存在：${move.from}`);
    if (findEntry(entries, move.to) || paths.some((path) => path.toLowerCase() === move.to.toLowerCase())) throw new Error(`目标已存在，不会覆盖：${move.to}`);
  }
  const changes = all.map((note) => ({ note, target: remapPath(note.path, moves), content: rewriteDocumentLinks(note.content, note.path, remapPath(note.path, moves), moves, paths) })).filter((item) => item.target !== item.note.path || item.content !== item.note.content);
  const stored = await api.drafts(), backup = `.noto-structure-backup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, made = new Set<string>();
  for (const draft of stored) {
    const target = remapPath(draft.path, moves);
    if (moves.some((move) => draft.path === move.to || draft.path.startsWith(`${move.to}/`))) throw new Error(`目标有恢复草稿，请先处理：${draft.path}`);
    if (target !== draft.path && stored.some((item) => item.path === target)) throw new Error(`目标有恢复草稿，请先处理：${target}`);
  }
  for(const draft of stored)if(isStructuredDocument(draft.path))rewriteDocumentLinks(draft.content,draft.path,remapPath(draft.path,moves),moves,paths);
  const changedDrafts = stored.filter((draft) => changes.some((item) => item.note.path === draft.path) || remapPath(draft.path, moves) !== draft.path || rewriteDocumentLinks(draft.content, draft.path, draft.path, moves, paths) !== draft.content);
  if (api.relocate) return api.relocate({ moves, edits: changes.map(({ note, target, content }) => ({ path: note.path, target, content, expectedVersion: note.version })), checks: all.map(({ path, version }) => ({ path, version })) }, all);
  async function backupFile(path: string, content: string) {
    const folder = parentPath(`${backup}/${path}`), parts = folder.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const dir = parts.slice(0, index).join("/");
      if (!made.has(dir)) { await api.createDirectory(dir); made.add(dir); }
    }
    return api.createNote(`${backup}/${path}`, content);
  }
  const results: Note[] = [], completedMoves: NoteMove[] = [];
  let log: Note | undefined;
  async function record(status: string) {
    if (!log) return;
    const content = `# 目录结构调整备份\n\n状态：${status}\n\n## 文件移动\n\n${moves.map((move) => `- [${completedMoves.includes(move) ? "x" : " "}] ${move.from} → ${move.to}`).join("\n")}\n\n## 已检查或更新的笔记\n\n${results.map((note) => `- ${note.path}`).join("\n")}\n\n修改前的 Markdown 在“原文”目录，草稿在“恢复草稿”目录。中断后请根据实际文件位置检查；不要覆盖目标或重复执行整批迁移。\n`;
    log = await api.save(log.path, content, log.version);
  }
  try {
    for (const item of changes) { if(api.backupDocument)await api.backupDocument(item.note.path,backup,item.note.version);else await backupFile(`原文/${item.note.path}`, item.note.content); }
    for (const draft of changedDrafts) {
      await backupFile(`恢复草稿/${draft.path}`, isStructuredDocument(draft.path)?draft.content:`<!-- base-version: ${draft.baseVersion} -->\n${draft.content}`);
      if(isStructuredDocument(draft.path))await backupFile(`恢复草稿/${draft.path}.meta.md`,JSON.stringify({path:draft.path,baseVersion:draft.baseVersion}));
    }
    log = await backupFile("迁移说明.md", `# 目录结构调整备份\n\n状态：准备完成\n\n${moves.map((move) => `- ${move.from} → ${move.to}`).join("\n")}\n\n修改前原文与草稿保存在本目录。\n`);
    for (const item of changes) if ((await api.read(item.note.path)).version !== item.note.version) throw new Error(`文件已在外部修改：${item.note.path}`);
    for (const move of moves) {
      if (parentPath(move.to)) await ensureDirectory(parentPath(move.to), api);
      await api.move(move.from, move.to);
      completedMoves.push(move);
      await record("进行中");
    }
    for (const item of changes) {
      const disk = await api.read(item.target);
      if (disk.version !== item.note.version) throw new Error(`文件在调整期间被修改：${item.target}`);
      results.push(item.content === disk.content ? disk : await api.save(item.target, item.content, disk.version));
      await record("进行中");
    }
    for (const draft of changedDrafts) {
      const item = changes.find((entry) => entry.note.path === draft.path), target = remapPath(draft.path, moves);
      const content = rewriteDocumentLinks(draft.content, draft.path, target, moves, paths);
      if (!item && target === draft.path && content === draft.content) continue;
      const saved = results.find((note) => note.path === target);
      await api.writeDraft({ path: target, content, baseVersion: item && saved && draft.baseVersion === item.note.version ? saved.version : draft.baseVersion });
      if (target !== draft.path) await api.removeDraft(draft.path);
    }
    await record("已完成");
    return { moves, notes: results, originals: all, backup };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await record(`未完成：${reason}`).catch(() => {});
    throw new RelocationError(`目录调整未全部完成：${reason}。备份保留在 ${backup}，请检查迁移说明及已移动的文件，不会自动覆盖重试。`, backup, completedMoves, all);
  }
}

export async function organizeLegacyVault(api: RelocationApi) {
  const entries = await api.entries(), moves: NoteMove[] = [];
  for (const file of findEntry(entries, "任务")?.children ?? []) {
    if (!file.isDirectory && isMarkdownPath(file.path) && isTaskCategoryDocument((await api.read(file.path)).content)) moves.push({ from: file.path, to: `${defaultTaskGroup}/${pathName(file.path)}` });
  }
  for (const file of findEntry(entries, "日记")?.children ?? []) {
    const date = /^(\d{4}-\d{2}-\d{2})\.md$/i.exec(file.name)?.[1];
    if (!file.isDirectory && date) {
      let target: string;
      try { target = dailyPath(date); } catch { continue; }
      moves.push({ from: file.path, to: target });
    }
  }
  return relocateNotes(moves, api);
}
