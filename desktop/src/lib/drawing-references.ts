import {parseDrawing,serializeDrawing} from "./drawing-document";
import type {PathMove} from "./vault-api";
export function rewriteDrawingReferences(source:string,moves:PathMove[]){
  const doc=parseDrawing(source);let changed=false;
  const elements=doc.elements.map(e=>{
    const link=e.link;if(!link)return e;
    const move=moves.find(m=>link.file===m.from||link.file.startsWith(m.from+"/"));
    if(!move)return e;changed=true;
    return {...e,link:{...link,file:move.to+link.file.slice(move.from.length)}};
  });
  return changed?serializeDrawing({...doc,elements}):source;
}
