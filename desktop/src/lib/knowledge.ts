// Shared saved-file index; syntax, targets and heading IDs have one-way dependencies.
import {decodeLink,resolveNoteLink} from "./markdown-links";
import {isMarkdown} from "./document-kind";
import type {Entry,Note} from "./desktop-api";
import {parseKnowledge} from "./wiki-syntax";
import {resolveWikiTarget,headingProblem} from "./wiki-target";
import {headingIndex,findHeading,type HeadingEntry} from "./heading-index";
import {parseNoteEmbeds,unsupportedEmbedFile} from "./note-embed";
import {blockIndex,findBlock,type BlockIndex} from "./wiki-block";
export {parseKnowledge,knowledgeForDoc,wikiCompletionAllowed,remarkWikiLinks,type WikiLink} from "./wiki-syntax";
export {resolveWiki,wikiTargetForPath,resolveWikiTarget} from "./wiki-target";

export function notePaths(entries:Entry[]):string[]{
 return entries.flatMap(entry=>entry.issue?[]:entry.isDirectory?notePaths(entry.children):isMarkdown(entry.path)?[entry.path]:[]);
}
export type Snapshot = { notes: Note[]; errors: { path: string; error: string }[] };
export type Backlink = { path: string; line: number; snippet: string };
export type NoteReference = {
  source: string; raw: string; kind: "wiki" | "markdown" | "embed"; from: number; line: number; snippet: string;
  heading?: {fragment:string;status:"resolved"|"missing"|"unknown"|"unsupported"|"invalid"|"ambiguous";id?:string;message?:string};
  status: "resolved" | "missing" | "ambiguous" | "invalid"; target: string | null; candidates: string[];
};
export type RelationIndex = { paths: string[]; readable: Set<string>; references: NoteReference[] };

// Cache only parse products of saved versions, never dirty sessions or UI state.
export class KnowledgeIndex {
 private cache=new Map<string,{version:string;content:string;parsed:ReturnType<typeof parseKnowledge>;embeds:ReturnType<typeof parseNoteEmbeds>;headings?:HeadingEntry[];blocks?:BlockIndex}>();
 build(paths:string[],notes:Note[]):RelationIndex {
  const known=new Set(paths),readable=new Set<string>(),references:NoteReference[]=[];
  for(const key of this.cache.keys())if(!known.has(key))this.cache.delete(key);
  for(const note of notes){
   if(!known.has(note.path))continue;
   readable.add(note.path);
   const old=this.cache.get(note.path);
   if(!old||old.version!==note.version||old.content!==note.content){const parsed=parseKnowledge(note.content);this.cache.set(note.path,{version:note.version,content:note.content,parsed,embeds:parseNoteEmbeds(note.content,parsed)});}
  }
  const targets=new Map<string,ReturnType<typeof resolveWikiTarget>>();
  for(const note of notes){
   if(!known.has(note.path))continue;
   const cached=this.cache.get(note.path)!;
   const add=(raw:string,kind:NoteReference["kind"],from:number,candidates:string[],invalid:boolean):NoteReference=>{
    const lineStart=note.content.lastIndexOf("\n",from-1)+1,lineEnd=note.content.indexOf("\n",from);
    const ref:NoteReference={source:note.path,raw,kind,from,line:note.content.slice(0,lineStart).split("\n").length,
     snippet:note.content.slice(lineStart,lineEnd<0?undefined:lineEnd).trim().slice(0,180),
     status:invalid?"invalid":candidates.length>1?"ambiguous":candidates.length?"resolved":"missing",target:candidates.length===1?candidates[0]:null,candidates};
    references.push(ref);return ref;
   };
   const links=[...cached.parsed.wiki.map(link=>({...link,kind:"wiki" as const})),...cached.embeds.filter(link=>link.target&&!unsupportedEmbedFile(resolveWikiTarget(link.target,note.path,paths).file)).map(link=>({...link,kind:"embed" as const}))];
   for(const link of links){
    const key=note.path+"\0"+link.target;
    let target=targets.get(key);if(!target){target=resolveWikiTarget(link.target,note.path,paths);targets.set(key,target);}
    const ref=add(link.target,link.kind,link.from,target.candidates,target.invalid);
    if(target.fragment!==null){
     const problem=headingProblem(target.fragment);
     ref.heading={fragment:target.fragment,status:problem?"invalid":"unknown",...(problem?{message:problem}:{})};
     if(!problem&&ref.status==="resolved"&&ref.target&&readable.has(ref.target)){
      const destination=this.cache.get(ref.target)!;
      if(target.fragment.startsWith("^")){
       destination.blocks??=blockIndex(destination.content);const hit=findBlock(destination.blocks,target.fragment.slice(1));
       ref.heading=hit.status==="resolved"?{fragment:target.fragment,status:"resolved",id:hit.block!.markers[0].id}:{fragment:target.fragment,status:hit.status,message:hit.status==="ambiguous"?"块 ID 重复或归属不明确":hit.status==="invalid"?"无效块 ID":"文件存在，块不存在"};
      }else{
       destination.headings??=headingIndex(destination.content);
       const hit=findHeading(destination.headings,target.fragment);
       ref.heading=hit?{fragment:target.fragment,status:"resolved",id:hit.id}:{fragment:target.fragment,status:"missing",message:"文件存在，标题不存在"};
      }
     }
    }
   }
   for(const link of cached.parsed.markdown){
    if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.url))continue;
    const raw=link.url.split("#",1)[0].split("?",1)[0];
    if(!raw||!isMarkdown(decodeLink(raw)))continue;
    const target=resolveNoteLink(note.path,raw);
    add(link.url,"markdown",link.from,target&&known.has(target)?[target]:[],!target);
   }
  }
  references.sort((a,b)=>a.source.localeCompare(b.source)||a.from-b.from);
  return {paths,readable,references};
 }
}
export const referenceHasIssue=(link:NoteReference)=>link.status!=="resolved"||!!link.heading&&link.heading.status!=="resolved";
export function referenceIssueText(link:NoteReference){
 if(link.status!=="resolved")return {missing:"目标不存在",ambiguous:"同名笔记",invalid:"无效目标",resolved:""}[link.status];
 return link.heading?.status==="unknown"?"标题尚未验证":link.heading?.message??"";
}

export function findBacklinks(target: string, notes: Note[], paths: string[]): Backlink[] {
  return new KnowledgeIndex().build(paths, notes).references
    .filter((link) => link.source !== target && link.status === "resolved" && link.target === target)
    .map((link) => ({ path: link.source, line: link.line, snippet: link.snippet }));
}

export function searchNotes(query: string, notes: Note[]): { path: string; line?: number; snippet: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return notes.flatMap((note) => {
    const lines = note.content.split("\n");
    const line = lines.findIndex((text) => text.toLowerCase().includes(needle));
    if (line >= 0) return [{ path: note.path, line: line + 1, snippet: lines[line].trim().slice(0, 180) }];
    if (note.path.toLowerCase().includes(needle)) return [{ path: note.path, snippet: "文件名匹配" }];
    return [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export async function scanNotes(paths: string[], read: (path: string) => Promise<Note>, cancelled: () => boolean): Promise<Snapshot> {
  const result: Snapshot = { notes: [], errors: [] };
  let index = 0;
  async function worker() {
    while (!cancelled()) {
      const path = paths[index++];
      if (!path) return;
      try { result.notes.push(await read(path)); }
      catch (error) { result.errors.push({ path, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, worker));
  return result;
}
