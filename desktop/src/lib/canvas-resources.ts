import type {VaultApi} from "./vault-api";
import {relativePath} from "./vault-structure";
import {safeExportImage} from "./export-resources";
import {isDrawing,isMarkdown} from "./document-kind";
import {drawingPreview} from "./drawing-preview";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const isCanvasImage=(path:string)=>/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
export type CanvasResource={text:string;image?:string;version?:string;previewMarkdown?:string};

const maxPreviewLength = 16 * 1024;
const previewParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function notePreview(source: string) {
  if (source.length <= maxPreviewLength) return source;
  const prefix = source.slice(0, maxPreviewLength).replace(/[\uD800-\uDBFF]$/u, "");
  const blocks = previewParser.parse(prefix).children;
  // The last block may contain a fence or formula cut by the length limit.
  return prefix.slice(0, blocks.at(-2)?.position?.end.offset ?? prefix.length);
}

export class CanvasResources {
  private cache=new Map<string,{promise:Promise<CanvasResource>;at:number;bytes:number}>();
  private queue:(()=>void)[]=[];private running=0;private disposed=false;private epoch=0;
  constructor(private api:Pick<VaultApi,"read"|"image">,private canvas:string){}
  invalidate(){this.epoch++;this.cache.clear();}
  dispose(){this.disposed=true;this.invalidate();this.queue.splice(0).forEach(run=>run());}
  load(path:string):Promise<CanvasResource>{
    const cached=this.cache.get(path);
    if(cached&&Date.now()-cached.at<5000){this.cache.delete(path);this.cache.set(path,cached);return cached.promise;}
    const epoch=this.epoch,entry={promise:Promise.resolve({text:""} as CanvasResource),at:Date.now(),bytes:0};
    entry.promise=new Promise<CanvasResource>((resolve,reject)=>{
      const run=()=>{
        if(this.disposed){reject(new Error("画布预览已关闭"));return;}
        this.running++;
        (async()=>{
          if(isCanvasImage(path))return {text:path,image:safeExportImage(await this.api.image(this.canvas,relativePath(this.canvas,path)))};
          if(isDrawing(path)){const note=await this.api.read(path);return {text:path,image:drawingPreview(note.content),version:note.version};}
          if(isMarkdown(path)){
            const note=await this.api.read(path);
            return {text:note.content.slice(0,600),previewMarkdown:notePreview(note.content),version:note.version};
          }
          return {text:"此文件不提供画布内预览，请打开文件"};
        })().then(value=>{
          if(this.epoch===epoch){entry.bytes=(value.text.length+(value.image?.length??0)+(value.previewMarkdown?.length??0))*2;this.trim();}
          resolve(value);
        },reject).finally(()=>{this.running--;this.queue.shift()?.();});
      };
      if(this.running<4)run();else this.queue.push(run);
    });
    entry.promise.catch(()=>{if(this.cache.get(path)===entry)this.cache.delete(path);});
    this.cache.set(path,entry);this.trim();return entry.promise;
  }
  private trim(){
    let bytes=[...this.cache.values()].reduce((n,e)=>n+e.bytes,0);
    for(const [path,e] of this.cache){if(this.cache.size<=64&&bytes<=16*1024*1024)break;this.cache.delete(path);bytes-=e.bytes;}
  }
}
