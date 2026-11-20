import {parseCanvas,serializeCanvas,canvasFilePath} from "./canvas-document";
import type {PathMove} from "./vault-api";
type RewriteText=(source:string,oldPath:string,newPath:string,moves:PathMove[],paths:string[])=>string;
const remap=(path:string,moves:PathMove[])=>{const move=moves.find(m=>path===m.from||path.startsWith(m.from+"/"));return move?move.to+path.slice(move.from.length):path;};
export function rewriteCanvasReferences(source:string,oldPath:string,newPath:string,moves:PathMove[],paths:string[],rewrite:RewriteText):string {
  const data=parseCanvas(source);let changed=false;
  const nodes=data.nodes.map(node=>{
    if(node.type==="file") {
      const file=remap(node.file!,moves);
      if(!canvasFilePath(file))throw new Error("无法安全调整画布引用："+node.file);
      if(file!==node.file){changed=true;return {...node,file};}
    }
    if(node.type==="text") {
      const text=rewrite(node.text!,oldPath,newPath,moves,paths);
      if(text!==node.text){changed=true;return {...node,text};}
    }
    return node;
  });
  return changed?serializeCanvas({...data,nodes}):source;
}
