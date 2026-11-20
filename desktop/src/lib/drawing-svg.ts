// SVG conversion adapted from Noteriv elementsToSVG (MIT); no raw HTML or links.
import {parseDrawing,drawingBytes,type DrawingElement} from "./drawing-document";
import {arrowHead,drawingExtent} from "./drawing-geometry";
export const maxDrawingSvgBytes=16*1024*1024;
const num=(n:number)=>String(Math.round(n*10000)/10000);
function xml(text:string){
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udfff]/u.test(text))throw new Error("文字包含 SVG 不支持的字符，源白板已保留");
  return text.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
}
function elementSvg(e:DrawingElement){
  const style=' stroke="'+e.strokeColor+'" stroke-width="'+num(e.strokeWidth??2)+'" stroke-linecap="round" stroke-linejoin="round"';
  if(e.type==="text")return '<text fill="'+e.strokeColor+'" font-size="'+num(e.fontSize!)+'" font-family="sans-serif" xml:space="preserve">'+e.text!.replace(/\t/g,"    ").split("\n").map((line,i)=>'<tspan x="'+num(e.x)+'" y="'+num(e.y+e.fontSize!+i*e.fontSize!*1.4)+'">'+xml(line)+'</tspan>').join("")+'</text>';
  if(e.type==="rectangle")return '<rect x="'+num(e.x)+'" y="'+num(e.y)+'" width="'+num(e.width)+'" height="'+num(e.height)+'" fill="'+(e.fillColor==="transparent"||!e.fillColor?"none":e.fillColor)+'"'+style+'/>';
  if(e.type==="ellipse")return '<ellipse cx="'+num(e.x+e.width/2)+'" cy="'+num(e.y+e.height/2)+'" rx="'+num(e.width/2)+'" ry="'+num(e.height/2)+'" fill="'+(e.fillColor==="transparent"||!e.fillColor?"none":e.fillColor)+'"'+style+'/>';
  if(e.type==="pencil"){
    if(e.points!.length===1)return '<circle cx="'+num(e.x+e.points![0][0])+'" cy="'+num(e.y+e.points![0][1])+'" r="'+num((e.strokeWidth??2)/2)+'" fill="'+e.strokeColor+'"/>';
    return '<polyline points="'+e.points!.map(([x,y])=>num(e.x+x)+","+num(e.y+y)).join(" ")+'" fill="none"'+style+'/>';
  }
  return '<line x1="'+num(e.x)+'" y1="'+num(e.y)+'" x2="'+num(e.x+e.width)+'" y2="'+num(e.y+e.height)+'"'+style+'/>'+(e.type==="arrow"?'<polygon points="'+arrowHead(e).map(p=>num(p.x)+","+num(p.y)).join(" ")+'" fill="'+e.strokeColor+'"/>':"");
}
export function drawingToSvg(source:string,measure?:(line:string,fontSize:number)=>number){
  const doc=parseDrawing(source),b=drawingExtent(doc.elements,measure),x=b.x-20,y=b.y-20,width=b.width+40,height=b.height+40;
  if(width>100000||height>100000)throw new Error("SVG 逻辑边长超过 100000，请缩小内容范围");
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+num(width)+'" height="'+num(height)+'" viewBox="'+[x,y,width,height].map(num).join(" ")+'">\n<rect x="'+num(x)+'" y="'+num(y)+'" width="'+num(width)+'" height="'+num(height)+'" fill="'+doc.background+'"/>\n'+doc.elements.map(elementSvg).join("\n")+"\n</svg>";
  if(drawingBytes(svg)>maxDrawingSvgBytes)throw new Error("SVG 超过 16 MiB，未生成部分文件");
  return svg;
}
export function downloadDrawingSvg(svg:string,name:string){
  if(drawingBytes(svg)>maxDrawingSvgBytes)throw new Error("SVG 超过 16 MiB");
  const url=URL.createObjectURL(new Blob([svg],{type:"image/svg+xml;charset=utf-8"})),link=document.createElement("a");
  let timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{clearTimeout(timer);URL.revokeObjectURL(url);window.removeEventListener("pagehide",release);};
  try{link.href=url;link.download=name;document.body.appendChild(link);link.click();}catch(cause){release();throw cause;}finally{link.remove();}
  window.addEventListener("pagehide",release,{once:true});timer=setTimeout(release,60000);
}
