import type {Note} from "./vault-api";
import {isMarkdown} from "./document-kind";
import {createSearchMatcher,matchesSearchFilters,type SearchOptions} from "./search-options";

export type SearchHit={key:string;from:number;to:number;line:number;column:number;text:string;before:string;after:string;snippet:{text:string;from:number;to:number;leading:boolean;trailing:boolean}};
export type SearchFile={path:string;note?:Note;pathMatched:boolean;hits:SearchHit[];truncated:boolean;unread:boolean};
export type SearchResults={query:string;files:SearchFile[];hits:number;truncated:boolean;unscanned:number};
export type SearchContext={query:string;options?:SearchOptions};
export type SearchChoice={context:SearchContext;file:SearchFile;hit?:SearchHit};
export type SearchHighlight={path:string;content:string;from:number;to:number;serial:number;query:string};
export type SearchLocal={note:Note;label:string};
export const normalizeSearchText=(text:string)=>text.replace(/\r\n?/g,"\n");
export const searchQuery=(query:string)=>query.trim().replace(/[\r\n]/g,"");
const literal=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const boundary=(source:string,offset:number,direction:number)=>{
 const code=source.charCodeAt(offset);
 return code>=0xdc00&&code<=0xdfff&&offset>0?offset+direction:offset;
};
export function literalMatches(content:string,query:string,limit=200):{ranges:{from:number;to:number}[];truncated:boolean}{
 const input=searchQuery(query);if(!input)return {ranges:[],truncated:false};
 const expression=new RegExp(literal(input),"giu"),ranges:{from:number;to:number}[]=[];
 for(let match=expression.exec(content);match;match=expression.exec(content)){
  if(ranges.length>=limit)return {ranges,truncated:true};
  ranges.push({from:match.index,to:match.index+match[0].length});
 }
 return {ranges,truncated:false};
}
export function createSearchHit(content:string,range:{from:number;to:number}):SearchHit{
 const {from,to}=range,prefix=content.slice(0,from),lines=prefix.split(/\r\n|\r|\n/);
 const lineStart=from-lines.at(-1)!.length,next=content.slice(to).search(/[\r\n]/),lineEnd=next<0?content.length:to+next;
 const start=boundary(content,Math.max(lineStart,from-65),-1),end=boundary(content,Math.min(lineEnd,from+95),1);
 return {key:from+":"+to,from,to,line:lines.length,column:[...lines.at(-1)!].length+1,text:content.slice(from,to),
  before:normalizeSearchText(content.slice(boundary(content,Math.max(0,from-48),-1),from)),
  after:normalizeSearchText(content.slice(to,boundary(content,Math.min(content.length,to+48),1))),
  snippet:{text:content.slice(start,end),from:from-start,to:Math.min(to,end)-start,leading:start>lineStart,trailing:end<lineEnd}};
}
function fileResult(path:string,note:Note|undefined,scan:ReturnType<typeof createSearchMatcher>|null,limit:number):SearchFile{
 const hits:SearchHit[]=[];let truncated=false;
 if(note&&scan)for(const range of scan(note.content)){
  if(hits.length===limit){truncated=true;break;}
  hits.push(createSearchHit(note.content,range));
 }
 return {path,note,pathMatched:scan?!!scan(path).next().value:true,hits,truncated,unread:!note};
}
export async function collectSearch(query:string,notes:Note[],paths:string[],cancelled:()=>boolean=()=>false,options:SearchOptions&{perFile?:number;total?:number;yield?:()=>Promise<void>;progress?:(result:SearchResults)=>void}={}):Promise<SearchResults|null>{
 const text=options.regex?query:searchQuery(query),result:SearchResults={query:text,files:[],hits:0,truncated:false,unscanned:0};
 if(!text&&!options.folder&&!options.tag&&!options.property)return result;
 const scan=text?createSearchMatcher(text,options):null;
 const known=new Map(notes.map(note=>[note.path,note])),files=[...new Set(paths)].filter(isMarkdown).sort((a,b)=>a.localeCompare(b));
 const perFile=Math.max(1,options.perFile??200),total=Math.max(1,options.total??2000);
 let reportedFiles=0,reportedAt=performance.now();
 for(let index=0;index<files.length;index++){
  if(cancelled())return null;
  if(result.hits>=total){result.truncated=true;result.unscanned=files.length-index;break;}
  const path=files[index],note=known.get(path);
  if(matchesSearchFilters(path,note,options)){
   const file=fileResult(path,note,scan,Math.min(perFile,total-result.hits));
   if(file.hits.length||file.pathMatched){result.files.push(file);result.hits+=file.hits.length;result.truncated||=file.truncated;}
  }
  if(index%12===11){
   if(options.progress&&result.files.length>reportedFiles&&performance.now()-reportedAt>=150){
    reportedFiles=result.files.length;reportedAt=performance.now();options.progress(result);
   }
   await (options.yield?.()??new Promise<void>(resolve=>setTimeout(resolve,0)));if(cancelled())return null;
  }
 }
 return result;
}
export function rawSearchOffset(content:string,offset:number){return normalizeSearchText(content.slice(0,offset)).length;}
export function sourceSearchOffset(content:string,normalizedOffset:number){
 let at=0,count=0;while(at<content.length&&count<normalizedOffset){at+=content[at]==="\r"&&content[at+1]==="\n"?2:1;count++;}return at;
}
// A changed document needs the complete captured context, not the nearest
// same word or a reused ordinal. The caller can explicitly request a new scan.
export function resolveSearchHit(note:Note,hit:SearchHit,current:string,query:string,options:SearchOptions={}):{from:number;to:number}|null{
 if(hit.from<0||hit.to>note.content.length||note.content.slice(hit.from,hit.to)!==hit.text)return null;
 if(note.content===current)return {from:hit.from,to:hit.to};
 const old=normalizeSearchText(note.content),now=normalizeSearchText(current),from=rawSearchOffset(note.content,hit.from),to=rawSearchOffset(note.content,hit.to);
 if(old===now)return {from:sourceSearchOffset(current,from),to:sourceSearchOffset(current,to)};
 if(!hit.before&&!hit.after)return null;
 // Context must have substance: matching only a surviving word/blank line
 // after deletion does not prove that it is the original occurrence.
 if(!(hit.before+hit.after).trim())return null;
 const context=hit.before+normalizeSearchText(hit.text)+hit.after;
 const matches:{from:number;to:number}[]=[];
 let count=0;
 for(const range of createSearchMatcher(query,options)(now)){
  if(++count>201)return null;
  if(now.slice(Math.max(0,range.from-hit.before.length),range.to+hit.after.length)===context)matches.push(range);
 }
 return matches.length===1?{from:sourceSearchOffset(current,matches[0].from),to:sourceSearchOffset(current,matches[0].to)}:null;
}
