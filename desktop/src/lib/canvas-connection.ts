import {canvasSide,type CanvasData,type CanvasEdge,type CanvasNode,type Point,type Side} from "./canvas-document";

export type CanvasEdgeEnd="from"|"to";
export type CanvasArrowDirection="end"|"start"|"both"|"none";

export function canvasArrowDirection(edge:CanvasEdge):CanvasArrowDirection {
  const start=edge.fromEnd==="arrow",end=edge.toEnd!=="none";
  return start?(end?"both":"start"):(end?"end":"none");
}

export function changeCanvasArrow(data:CanvasData,id:string,direction:CanvasArrowDirection):CanvasData {
  const edge=data.edges.find(e=>e.id===id);
  if(!edge||canvasArrowDirection(edge)===direction)return data;
  return {...data,edges:data.edges.map(e=>e.id!==id?e:{...e,fromEnd:direction==="start"||direction==="both"?"arrow":"none",toEnd:direction==="end"||direction==="both"?"arrow":"none"})};
}

export function changeCanvasEdgeSide(data:CanvasData,id:string,end:CanvasEdgeEnd,side:Side|"auto"):CanvasData {
  const edge=data.edges.find(e=>e.id===id),key=end==="from"?"fromSide":"toSide";
  if(!edge||(edge[key]??"auto")===side)return data;
  return {...data,edges:data.edges.map(e=>e.id!==id?e:{...e,[key]:side==="auto"?undefined:side})};
}

export function nearestCanvasSide(node:CanvasNode,point:Point):Side {
  const distances:[Side,number][]=[["top",Math.abs(point.y-node.y)],["right",Math.abs(point.x-node.x-node.width)],["bottom",Math.abs(point.y-node.y-node.height)],["left",Math.abs(point.x-node.x)]];
  return distances.reduce((best,item)=>item[1]<best[1]?item:best)[0];
}

export function reconnectCanvasEdge(data:CanvasData,id:string,end:CanvasEdgeEnd,targetId:string,side:Side):CanvasData {
  const edge=data.edges.find(e=>e.id===id),target=data.nodes.find(n=>n.id===targetId);
  if(!edge||!target)return data;
  const otherId=end==="from"?edge.toNode:edge.fromNode,other=data.nodes.find(n=>n.id===otherId);
  if(!other||targetId===otherId)return data;
  const from=end==="from"?targetId:edge.fromNode,to=end==="to"?targetId:edge.toNode;
  const oldNode=end==="from"?edge.fromNode:edge.toNode;
  if(oldNode!==targetId&&data.edges.some(e=>e.id!==id&&e.fromNode===from&&e.toNode===to))throw new Error("这两个节点已连接");
  const oldSide=(end==="from"?edge.fromSide:edge.toSide)??canvasSide(target,other);
  if(oldNode===targetId&&oldSide===side)return data;
  return {...data,edges:data.edges.map(e=>e.id!==id?e:end==="from"?{...e,fromNode:targetId,fromSide:side}:{...e,toNode:targetId,toSide:side})};
}
