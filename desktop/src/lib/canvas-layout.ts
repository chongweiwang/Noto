import {canvasVisible,contains,type CanvasData,type CanvasNode,type CanvasViewport,type Point} from "./canvas-document";

export type CanvasLayout="left"|"center-x"|"right"|"top"|"center-y"|"bottom"|"distribute-x"|"distribute-y";
export type CanvasGuide={axis:"x"|"y";at:number;start:number;end:number};

// A selected group and its contained cards form one movable unit, matching drag.
export function canvasLayoutUnits(data:CanvasData,selected:Set<string>):CanvasNode[]{
  const nodes=data.nodes.filter(node=>selected.has(node.id)),groups=nodes.filter(node=>node.type==="group");
  return nodes.filter(node=>node.type==="group"||!groups.some(group=>contains(group,node)));
}

export function arrangeCanvasNodes(data:CanvasData,selected:Set<string>,layout:CanvasLayout):CanvasData {
  const units=canvasLayoutUnits(data,selected),distribute=layout.startsWith("distribute-");
  if(units.length<(distribute?3:2))return data;
  const targets=new Map<string,Point>(),horizontal=layout==="left"||layout==="center-x"||layout==="right"||layout==="distribute-x";
  if(distribute){
    const axis=horizontal?"x":"y",extent=horizontal?"width":"height",ordered=[...units].sort((a,b)=>a[axis]-b[axis]);
    const start=ordered[0][axis],end=ordered.at(-1)![axis],occupied=ordered.slice(0,-1).reduce((sum,n)=>sum+n[extent],0),gap=(end-start-occupied)/(ordered.length-1);
    let offset=0;
    ordered.forEach((node,index)=>{const position=Math.round(start+offset+gap*index);targets.set(node.id,horizontal?{x:position,y:node.y}:{x:node.x,y:position});offset+=node[extent];});
  }else{
    const left=Math.min(...units.map(n=>n.x)),right=Math.max(...units.map(n=>n.x+n.width)),top=Math.min(...units.map(n=>n.y)),bottom=Math.max(...units.map(n=>n.y+n.height));
    for(const node of units){
      const x=layout==="left"?left:layout==="right"?right-node.width:layout==="center-x"?Math.round((left+right-node.width)/2):node.x;
      const y=layout==="top"?top:layout==="bottom"?bottom-node.height:layout==="center-y"?Math.round((top+bottom-node.height)/2):node.y;
      targets.set(node.id,{x,y});
    }
  }
  const deltas=new Map<string,Point>();
  for(const node of units){
    const target=targets.get(node.id)!,delta={x:target.x-node.x,y:target.y-node.y};deltas.set(node.id,delta);
    if(node.type==="group")for(const child of data.nodes){
      if(child.type==="group"||!contains(node,child))continue;
      const previous=deltas.get(child.id);
      if(previous&&(previous.x!==delta.x||previous.y!==delta.y))throw new Error("所选分组包含共同节点，请分别调整这些分组。");
      deltas.set(child.id,delta);
    }
  }
  let changed=false;
  const nodes=data.nodes.map(node=>{const delta=deltas.get(node.id);if(!delta||!delta.x&&!delta.y)return node;changed=true;return {...node,x:node.x+delta.x,y:node.y+delta.y};});
  return changed?{...data,nodes}:data;
}

export function snapCanvasMove(data:CanvasData,ids:Set<string>,dx:number,dy:number,viewport:CanvasViewport,width:number,height:number):{dx:number;dy:number;guides:CanvasGuide[]} {
  const moving=data.nodes.filter(node=>ids.has(node.id)),targets=data.nodes.filter(node=>!ids.has(node.id)&&canvasVisible(node,viewport,width,height,0));
  let x=Math.round(dx),y=Math.round(dy);
  if(!moving.length||!targets.length)return {dx:x,dy:y,guides:[]};
  const left=Math.min(...moving.map(n=>n.x)),right=Math.max(...moving.map(n=>n.x+n.width)),top=Math.min(...moving.map(n=>n.y)),bottom=Math.max(...moving.map(n=>n.y+n.height));
  const tolerance=6/viewport.zoom;
  type Match={distance:number;delta:number;at:number;node:CanvasNode};
  let matchX:Match|undefined,matchY:Match|undefined;
  for(const node of targets){
    for(const a of [left,(left+right)/2,right])for(const b of [node.x,node.x+node.width/2,node.x+node.width]){
      const difference=b-(a+x),distance=Math.abs(difference);
      if(distance<=tolerance&&Math.abs(difference-Math.round(difference))<1e-9&&(!matchX||distance<matchX.distance))matchX={distance,delta:Math.round(difference),at:b,node};
    }
    for(const a of [top,(top+bottom)/2,bottom])for(const b of [node.y,node.y+node.height/2,node.y+node.height]){
      const difference=b-(a+y),distance=Math.abs(difference);
      if(distance<=tolerance&&Math.abs(difference-Math.round(difference))<1e-9&&(!matchY||distance<matchY.distance))matchY={distance,delta:Math.round(difference),at:b,node};
    }
  }
  if(matchX)x+=matchX.delta;if(matchY)y+=matchY.delta;
  const pad=12/viewport.zoom,guides:CanvasGuide[]=[];
  if(matchX)guides.push({axis:"x",at:matchX.at,start:Math.min(top+y,matchX.node.y)-pad,end:Math.max(bottom+y,matchX.node.y+matchX.node.height)+pad});
  if(matchY)guides.push({axis:"y",at:matchY.at,start:Math.min(left+x,matchY.node.x)-pad,end:Math.max(right+x,matchY.node.x+matchY.node.width)+pad});
  return {dx:x,dy:y,guides};
}
