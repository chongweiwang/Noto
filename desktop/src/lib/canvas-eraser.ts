import {canvasFreehand,createCanvasFreehand,type CanvasData,type CanvasNode,type Point} from "./canvas-document";
import {eraseDrawingSegment} from "./drawing-geometry";
import type {DrawingData,DrawingElement} from "./drawing-document";

// Canvas strokes use normalized points; reuse the whiteboard's segment/capsule
// clipping in world coordinates, then restore the canvas node's metadata.
export function eraseCanvasFreehand(data:CanvasData,a:Point,b:Point,tolerance:number):CanvasData {
  let changed=false;
  const nodes:CanvasNode[]=[],removed=new Set<string>();
  for(const node of data.nodes){
    const stroke=canvasFreehand(node);
    if(!stroke){nodes.push(node);continue;}
    const r=tolerance+stroke.strokeWidth/2;
    if(Math.max(a.x,b.x)+r<node.x||Math.min(a.x,b.x)-r>node.x+node.width||Math.max(a.y,b.y)+r<node.y||Math.min(a.y,b.y)-r>node.y+node.height){nodes.push(node);continue;}
    const element:DrawingElement={id:node.id,type:"pencil",x:node.x,y:node.y,width:node.width,height:node.height,strokeColor:stroke.strokeColor,strokeWidth:stroke.strokeWidth,points:stroke.points.map(([x,y])=>[x*node.width,y*node.height])};
    const drawing:DrawingData={type:"noto-drawing",version:1,background:"#ffffff",elements:[element]};
    const result=eraseDrawingSegment(drawing,a,b,tolerance);
    if(result===drawing){nodes.push(node);continue;}
    changed=true;
    if(!result.elements.length){removed.add(node.id);continue;}
    for(const fragment of result.elements){
      const world=fragment.points!.map(([x,y])=>({x:fragment.x+x,y:fragment.y+y}));
      const geometry=createCanvasFreehand(world,stroke.strokeColor,stroke.strokeWidth,fragment.id),points=canvasFreehand(geometry)!.points;
      nodes.push({...node,id:fragment.id,x:geometry.x,y:geometry.y,width:geometry.width,height:geometry.height,notoDrawing:{...stroke,points}});
    }
  }
  if(!changed)return data;
  return {...data,nodes,edges:removed.size?data.edges.filter(e=>!removed.has(e.fromNode)&&!removed.has(e.toNode)):data.edges};
}
