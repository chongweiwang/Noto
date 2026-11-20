// Canvas 2D geometry/hit tests adapted from Noteriv DrawingEditor.tsx (MIT).
import type {DrawingData,DrawingElement,DrawingStyle,DrawingType} from "./drawing-document";
import type {EraserMode} from "./eraser-settings";
import {newDrawingId,roundDrawing,drawingTextSize,drawingTextBounds,maxStrokePoints} from "./drawing-document";
import {canvasWorld,zoomCanvas,type Point,type CanvasViewport} from "./canvas-document";
export {canvasWorld as drawingWorld,zoomCanvas as zoomDrawing};
export type Box={x:number;y:number;width:number;height:number};
export const distanceToSegment=(p:Point,a:Point,b:Point)=>{
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length)):0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
};
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function segmentDistance(a:Point,b:Point,c:Point,d:Point){
  if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))&&Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y)))return 0;
  return Math.min(distanceToSegment(a,c,d),distanceToSegment(b,c,d),distanceToSegment(c,a,b),distanceToSegment(d,a,b));
}
export function drawingBox(e:DrawingElement):Box {
  return {x:Math.min(e.x,e.x+e.width),y:Math.min(e.y,e.y+e.height),width:Math.abs(e.width),height:Math.abs(e.height)};
}
export function arrowHead(e:DrawingElement):Point[]{
  const end={x:e.x+e.width,y:e.y+e.height},angle=Math.atan2(e.height,e.width),size=Math.min(Math.max(8,(e.strokeWidth??2)*4),Math.hypot(e.width,e.height)*.6);
  return [end,{x:end.x-size*Math.cos(angle-.45),y:end.y-size*Math.sin(angle-.45)},{x:end.x-size*Math.cos(angle+.45),y:end.y-size*Math.sin(angle+.45)}];
}
export function drawingBounds(e:DrawingElement):Box {
  const b=drawingBox(e),pad=e.type==="text"?2:(e.strokeWidth??2)/2;
  const points=e.type==="arrow"?[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y+b.height},...arrowHead(e)]:[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y+b.height}];
  const x=Math.min(...points.map(p=>p.x))-pad,y=Math.min(...points.map(p=>p.y))-pad;
  return {x,y,width:Math.max(...points.map(p=>p.x))-x+pad,height:Math.max(...points.map(p=>p.y))-y+pad};
}
export function boxesOverlap(a:Box,b:Box){return a.x<=b.x+b.width&&a.x+a.width>=b.x&&a.y<=b.y+b.height&&a.y+a.height>=b.y;}
export const boxContains=(a:Box,b:Box)=>b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height;
export function drawingOutline(e:DrawingElement):Point[]{
  const b=drawingBox(e);
  if(e.type==="pencil")return e.points!.map(([x,y])=>({x:e.x+x,y:e.y+y}));
  if(e.type==="line"||e.type==="arrow")return [{x:e.x,y:e.y},{x:e.x+e.width,y:e.y+e.height},...(e.type==="arrow"?[...arrowHead(e).slice(1),arrowHead(e)[0]]:[])];
  if(e.type==="ellipse")return Array.from({length:65},(_,i)=>({x:b.x+b.width/2+Math.cos(i*Math.PI/32)*b.width/2,y:b.y+b.height/2+Math.sin(i*Math.PI/32)*b.height/2}));
  return [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height},{x:b.x,y:b.y}];
}
function filledInside(e:DrawingElement,p:Point){
  const b=drawingBox(e);if(!boxContains(b,{...p,width:0,height:0}))return false;
  if(e.type==="text")return true;
  if(["rectangle","ellipse"].includes(e.type)&&e.fillColor&&e.fillColor!=="transparent")return e.type!=="ellipse"||((p.x-b.x-b.width/2)/(b.width/2))**2+((p.y-b.y-b.height/2)/(b.height/2))**2<=1;
  return false;
}
export function hitDrawingSegment(e:DrawingElement,a:Point,b:Point,tolerance:number){
  const r=tolerance+(e.strokeWidth??2)/2,range={x:Math.min(a.x,b.x)-r,y:Math.min(a.y,b.y)-r,width:Math.abs(a.x-b.x)+2*r,height:Math.abs(a.y-b.y)+2*r};
  if(!boxesOverlap(range,drawingBounds(e)))return false;
  if(filledInside(e,a)||filledInside(e,b))return true;
  const points=drawingOutline(e);
  if(points.length===1)return distanceToSegment(points[0],a,b)<=r;
  for(let i=1;i<points.length;i++)if(segmentDistance(a,b,points[i-1],points[i])<=r)return true;
  if(e.type==="arrow"){
    const [p,q,s]=arrowHead(e),v=[cross(p,q,a),cross(q,s,a),cross(s,p,a)];
    if(v.every(n=>n>=0)||v.every(n=>n<=0))return true;
  }
  return false;
}
export const hitDrawing=(e:DrawingElement,p:Point,tolerance:number)=>hitDrawingSegment(e,p,p,tolerance);

// Intersect one stroke segment with the capsule swept by the eraser.  Using
// segment intersections instead of sampled points also handles sparse strokes.
function erasedIntervals(p:Point,q:Point,a:Point,b:Point,r:number):[number,number][] {
  const dx=q.x-p.x,dy=q.y-p.y,intervals:[number,number][]=[];
  const circle=(c:Point)=>{
    const x=p.x-c.x,y=p.y-c.y,aa=dx*dx+dy*dy,bb=2*(x*dx+y*dy),cc=x*x+y*y-r*r;
    if(aa<1e-12){if(cc<=0)intervals.push([0,1]);return;}
    const disc=bb*bb-4*aa*cc;if(disc<0)return;
    const root=Math.sqrt(Math.max(0,disc)),lo=Math.max(0,(-bb-root)/(2*aa)),hi=Math.min(1,(-bb+root)/(2*aa));
    if(lo<=hi)intervals.push([lo,hi]);
  };
  circle(a);
  const length=Math.hypot(b.x-a.x,b.y-a.y);
  if(length>1e-9){
    circle(b);
    const ux=(b.x-a.x)/length,uy=(b.y-a.y)/length;
    const x=(p.x-a.x)*ux+(p.y-a.y)*uy,y=-(p.x-a.x)*uy+(p.y-a.y)*ux;
    const vx=dx*ux+dy*uy,vy=-dx*uy+dy*ux;
    let lo=0,hi=1;
    for(const [origin,delta,min,max] of [[x,vx,0,length],[y,vy,-r,r]]){
      if(Math.abs(delta)<1e-12){if(origin<min||origin>max)return intervals;continue;}
      const t1=(min-origin)/delta,t2=(max-origin)/delta;
      lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));
      if(lo>hi)return intervals;
    }
    intervals.push([lo,hi]);
  }
  return intervals;
}

/** Cut pencil strokes or remove whole hit objects, according to the selected mode. */
export function eraseDrawingSegment(data:DrawingData,a:Point,b:Point,tolerance:number,measure?:(line:string,fontSize:number)=>number,mode:EraserMode="stroke"):DrawingData {
  let changed=false;
  const elements:DrawingElement[]=[];
  for(const e of data.elements){
    if(mode==="stroke"&&e.type!=="pencil"){elements.push(e);continue;}
    if(!hitDrawingSegment(drawingTextBounds(e,measure),a,b,tolerance)){elements.push(e);continue;}
    if(mode==="object"){changed=true;continue;}
    const points=e.points!.map(([x,y])=>({x:e.x+x,y:e.y+y}));
    if(points.length===1){changed=true;continue;}
    const fragments:Point[][]=[];let fragment:Point[]=[];
    const append=(p:Point)=>{const last=fragment.at(-1);if(!last||Math.hypot(last.x-p.x,last.y-p.y)>1e-7)fragment.push(p);};
    const finish=()=>{if(fragment.length)fragments.push(fragment);fragment=[];};
    let cut=false;
    const radius=tolerance+(e.strokeWidth??2)/2;
    for(let i=1;i<points.length;i++){
      const p=points[i-1],q=points[i],at=(t:number)=>({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});
      const ranges=erasedIntervals(p,q,a,b,radius).sort((x,y)=>x[0]-y[0]);
      if(!ranges.length){append(p);append(q);continue;}
      cut=true;let cursor=0;
      for(const [lo,hi] of ranges){
        if(hi<cursor)continue;
        if(lo>cursor+1e-9){append(at(cursor));append(at(lo));}
        finish();cursor=Math.max(cursor,hi);
      }
      if(cursor<1-1e-9){append(at(cursor));append(q);}
    }
    finish();
    if(!cut){elements.push(e);continue;}
    changed=true;
    for(const [index,part] of fragments.entries()){
      const rounded=part.map(p=>({x:roundDrawing(p.x),y:roundDrawing(p.y)}));
      const geometry=pencilElement(rounded,{strokeColor:e.strokeColor,strokeWidth:e.strokeWidth??2,fillColor:"transparent",fontSize:20},index?newDrawingId():e.id);
      elements.push({...e,...geometry});
    }
  }
  return changed?{...data,elements}:data;
}
export function createDrawingElement(type:DrawingType,start:Point,end:Point,style:DrawingStyle,id=newDrawingId()):DrawingElement {
  const line=type==="line"||type==="arrow",text=type==="text";
  return {id,type,x:roundDrawing(line||text?start.x:Math.min(start.x,end.x)),y:roundDrawing(line||text?start.y:Math.min(start.y,end.y)),
    ...(text?drawingTextSize("",style.fontSize):{width:roundDrawing(line?end.x-start.x:Math.max(1,Math.abs(end.x-start.x))),height:roundDrawing(line?end.y-start.y:Math.max(1,Math.abs(end.y-start.y)))}),
    strokeColor:style.strokeColor,...(text?{fontSize:style.fontSize,text:""}:{strokeWidth:style.strokeWidth}),
    ...(["rectangle","ellipse"].includes(type)?{fillColor:style.fillColor}:{})};
}
export function pencilElement(points:Point[],style:DrawingStyle,id=newDrawingId()):DrawingElement {
  if(!points.length||points.length>maxStrokePoints)throw new Error("单笔超过 10000 点，本次笔划未提交");
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const p of points){x=Math.min(x,p.x);y=Math.min(y,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}
  x=roundDrawing(x);y=roundDrawing(y);
  const local=points.map(p=>[roundDrawing(p.x-x),roundDrawing(p.y-y)] as [number,number]);
  return {id,type:"pencil",x,y,width:Math.max(1,roundDrawing(right-x)),height:Math.max(1,roundDrawing(bottom-y)),strokeColor:style.strokeColor,strokeWidth:style.strokeWidth,points:local};
}
export function resizeDrawingElement(e:DrawingElement,corner:string,dx:number,dy:number):DrawingElement {
  if(e.type==="text")return e;
  if(e.type==="line"||e.type==="arrow")return corner==="start"?{...e,x:roundDrawing(e.x+dx),y:roundDrawing(e.y+dy),width:roundDrawing(e.width-dx),height:roundDrawing(e.height-dy)}:{...e,width:roundDrawing(e.width+dx),height:roundDrawing(e.height+dy)};
  const west=corner.includes("w"),north=corner.includes("n"),width=Math.max(1,roundDrawing(e.width+(west?-dx:dx))),height=Math.max(1,roundDrawing(e.height+(north?-dy:dy)));
  return {...e,x:west?roundDrawing(e.x+e.width-width):e.x,y:north?roundDrawing(e.y+e.height-height):e.y,width,height,
    ...(e.type==="pencil"?{points:e.points!.map(([x,y])=>[roundDrawing(x*width/e.width),roundDrawing(y*height/e.height)] as [number,number])}:{})};
}
export function drawingExtent(elements:DrawingElement[],measure?:(line:string,fontSize:number)=>number):Box {
  if(!elements.length)return {x:0,y:0,width:200,height:100};
  const bounds=elements.map(e=>drawingBounds(drawingTextBounds(e,measure))),x=Math.min(...bounds.map(b=>b.x)),y=Math.min(...bounds.map(b=>b.y));
  return {x,y,width:Math.max(...bounds.map(b=>b.x+b.width))-x,height:Math.max(...bounds.map(b=>b.y+b.height))-y};
}
export function fitDrawing(elements:DrawingElement[],width:number,height:number):CanvasViewport {
  if(!elements.length)return {x:width/2,y:height/2,zoom:1};
  const b=drawingExtent(elements),zoom=Math.max(.15,Math.min(2,(width-80)/Math.max(1,b.width),(height-80)/Math.max(1,b.height)));
  return {zoom,x:width/2-(b.x+b.width/2)*zoom,y:height/2-(b.y+b.height/2)*zoom};
}
export function drawingVisible(e:DrawingElement,v:CanvasViewport,width:number,height:number){
  const a=canvasWorld({x:-30,y:-30},v),b=canvasWorld({x:width+30,y:height+30},v);
  return boxesOverlap(drawingBounds(e),{...a,width:b.x-a.x,height:b.y-a.y});
}
export function drawingSurfaceSize(width:number,height:number,dpr:number){
  const w=Math.max(1,width),h=Math.max(1,height),ratio=Math.min(2,Math.max(.1,dpr||1),8192/w,8192/h,Math.sqrt(16000000/(w*h)));
  return {width:Math.max(1,Math.floor(w*ratio)),height:Math.max(1,Math.floor(h*ratio)),ratio};
}
// Adapted from Noteriv drawEl; stable world geometry shared with SVG output.
export function paintDrawingElement(ctx:CanvasRenderingContext2D,e:DrawingElement){
  ctx.save();ctx.strokeStyle=e.strokeColor;ctx.fillStyle=e.fillColor??"transparent";ctx.lineWidth=e.strokeWidth??2;ctx.lineCap="round";ctx.lineJoin="round";
  if(e.type==="pencil"){
    if(e.points!.length===1){ctx.beginPath();ctx.arc(e.x+e.points![0][0],e.y+e.points![0][1],(e.strokeWidth??2)/2,0,Math.PI*2);ctx.fillStyle=e.strokeColor;ctx.fill();}
    else {ctx.beginPath();e.points!.forEach(([x,y],i)=>i?ctx.lineTo(e.x+x,e.y+y):ctx.moveTo(e.x+x,e.y+y));ctx.stroke();}
  }else if(e.type==="rectangle"){if(e.fillColor&&e.fillColor!=="transparent")ctx.fillRect(e.x,e.y,e.width,e.height);ctx.strokeRect(e.x,e.y,e.width,e.height);}
  else if(e.type==="ellipse"){ctx.beginPath();ctx.ellipse(e.x+e.width/2,e.y+e.height/2,e.width/2,e.height/2,0,0,Math.PI*2);if(e.fillColor&&e.fillColor!=="transparent")ctx.fill();ctx.stroke();}
  else if(e.type==="line"||e.type==="arrow"){
    ctx.beginPath();ctx.moveTo(e.x,e.y);ctx.lineTo(e.x+e.width,e.y+e.height);ctx.stroke();
    if(e.type==="arrow"){ctx.beginPath();arrowHead(e).forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle=e.strokeColor;ctx.fill();}
  }else {ctx.font=e.fontSize+"px sans-serif";ctx.fillStyle=e.strokeColor;ctx.textBaseline="alphabetic";e.text!.replace(/\t/g,"    ").split("\n").forEach((line,i)=>ctx.fillText(line,e.x,e.y+e.fontSize!+i*e.fontSize!*1.4));}
  ctx.restore();
}
