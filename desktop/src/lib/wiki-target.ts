import {decodeString} from "micromark-util-decode-string";
import {isMarkdown} from "./document-kind";
import {parseKnowledge,type WikiLink} from "./wiki-syntax";
const withoutExtension=(path:string)=>path.replace(/\.(?:md|markdown)$/i,"");

// Wiki paths containing / are rooted at the vault. Bare names match basenames;
// case-insensitive duplicates are returned together rather than guessed.
export function resolveWiki(target: string, paths: string[]): string[] {
  const input = target.trim().replaceAll("\\", "/");
  const rootAnchored = input.startsWith("./");
  const normalized = rootAnchored ? input.slice(2) : input;
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..") || normalized.includes(":")) return [];
  const wanted = withoutExtension(normalized).toLowerCase();
  const fullPath = rootAnchored || normalized.includes("/");
  const matches = paths.filter((path) => {
    const candidate = fullPath ? path : path.split("/").pop() ?? "";
    return withoutExtension(candidate).toLowerCase() === wanted && (!/\.(?:md|markdown)$/i.test(normalized) || candidate.toLowerCase().endsWith(normalized.slice(normalized.lastIndexOf(".")).toLowerCase()));
  }).sort((a, b) => a.localeCompare(b));
  if (matches.length > 1 && fullPath && /\.(?:md|markdown)$/i.test(normalized) && matches.includes(normalized)) return [normalized];
  return matches;
}

// A completion must remain unambiguous even when a root note shares a name
// with a nested one or .md and .markdown files have the same stem.
export function wikiTargetForPath(path: string, paths: string[]): string {
  const stem = withoutExtension(path);
  const base = !path.includes("/") && resolveWiki(stem, paths).length > 1 ? `./${stem}` : stem;
  if (resolveWiki(base, paths).length === 1) return base;
  return path.includes("/") ? path : `./${path}`;
}


export type WikiTarget={file:string;fragment:string|null;candidates:string[];invalid:boolean};
const validFile=(value:string)=>{
 const path=value.trim().replaceAll("\\","/").replace(/^\.\//,"");
 return !!path&&!path.startsWith("/")&&!/[:\u0000-\u001f\u007f]/.test(path)&&path.split("/").every(part=>!!part&&part!=="."&&part!=="..");
};
// File-first resolution follows Noteriv's navigation; Noto also keeps ambiguity
// and the longest real file prefix, including literal # and % in file names.
export function resolveWikiTarget(value:string,source:string,paths:string[]):WikiTarget{
 const target=value.trim(),whole=resolveWiki(target,paths);
 if(whole.length)return {file:target,fragment:null,candidates:whole,invalid:false};
 const first=target.indexOf("#");
 if(first<0)return {file:target,fragment:null,candidates:[],invalid:!validFile(target)};
 for(let at=target.lastIndexOf("#");at>=first;at=target.lastIndexOf("#",at-1)){
  const file=target.slice(0,at).trim();
  if(file){const candidates=resolveWiki(file,paths);if(candidates.length)return {file,fragment:target.slice(at+1).trim(),candidates,invalid:false};}
  if(at===0)break;
 }
 const file=target.slice(0,first).trim(),fragment=target.slice(first+1).trim();
 return file?{file,fragment,candidates:[],invalid:!validFile(file)}:
  {file,fragment,candidates:isMarkdown(source)?[source]:[],invalid:!isMarkdown(source)};
}
export const headingProblem=(fragment:string|null)=>fragment===null?"":!fragment?"缺少标题":fragment.startsWith("^")?"不支持的 Wiki 链接片段":"";
export function encodeWikiText(value:string){
 if(/[\r\n\u0000-\u001f\u007f]/.test(value))throw new Error("Wiki 链接不能包含换行或控制字符");
 return value.replace(/[&<>\[\]|\\*_~`!$:]/g,char=>"&#"+char.charCodeAt(0)+";");
}
export const wikiHeadingFile=(path:string)=>(path.includes("/")?"":"./")+path;
export function formatWikiHeading(path:string,heading:{id:string;text:string},paths:string[],alias=heading.text){
 if(path.includes("|"))throw new Error("此文件名无法安全生成 Wiki 链接，请使用标准 Markdown 链接");
 const file=wikiHeadingFile(path),target=file+"#"+heading.id,parsed=resolveWikiTarget(target,path,paths);
 if(parsed.fragment!==heading.id||parsed.candidates.length!==1||parsed.candidates[0]!==path)
  throw new Error("标题链接与已有文件名冲突，请使用标准 Markdown 标题链接");
 const value="[["+encodeWikiText(file)+"#"+encodeWikiText(heading.id)+"|"+encodeWikiText(alias)+"]]";
 const parsedLink=parseKnowledge(value).wiki[0];
 if(!parsedLink||parsedLink.target!==target||parsedLink.label!==alias)throw new Error("此标题无法安全生成 Wiki 显示文字，请使用标准 Markdown 标题链接");
 return value;
}
// Boundaries in the decoded target are mapped back to original source bytes.
// Never guess a # or | in the raw spelling (entities/escapes can contain them).
export function wikiFileRange(source:string,link:WikiLink,file:string){
 const raw=source.slice(link.from+2,link.to-2);
 let decoded="",positions:(number|undefined)[]=[0];
 for(let at=0;at<raw.length;){
  const rest=raw.slice(at);
  const atom=/^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.exec(rest)?.[0]??
   /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);/.exec(rest)?.[0]??raw[at];
  const value=decodeString(atom),start=decoded.length;decoded+=value;
  for(let i=1;i<=value.length;i++)positions[start+i]=i===value.length?at+atom.length:undefined;
  at+=atom.length;
 }
 const start=decoded.length-decoded.trimStart().length,end=start+file.length;
 if(decoded!==decodeString(raw)||decoded.slice(start,end)!==file||positions[start]===undefined||positions[end]===undefined)
  throw new Error("Wiki 链接无法无损改写，请先在原文中调整");
 return {from:link.from+2+positions[start]!,to:link.from+2+positions[end]!};
}
