import {expect,it} from "vitest";
import {canvasArrowDirection,changeCanvasArrow,changeCanvasEdgeSide,nearestCanvasSide,reconnectCanvasEdge} from "./canvas-connection";
import {createCanvasNode,parseCanvas,serializeCanvas,type CanvasData} from "./canvas-document";

const node=(id:string,x:number)=>createCanvasNode("text",{x,y:0},{id,width:100,height:80,text:id});
const fixture=():CanvasData=>({nodes:[node("a",0),node("b",300),node("c",600)],edges:[{id:"edge",fromNode:"a",toNode:"b",label:"关联",extra:{keep:true}}],extra:"保留"});

it("箭头方向和端点侧边使用已有字段，默认与未知属性可往返",()=>{
 const data=fixture(),edge=data.edges[0];expect(canvasArrowDirection(edge)).toBe("end");expect(changeCanvasArrow(data,"edge","end")).toBe(data);
 for(const [direction,fromEnd,toEnd] of [["start","arrow","none"],["end","none","arrow"],["both","arrow","arrow"],["none","none","none"]] as const){
  const changed=changeCanvasArrow(data,"edge",direction);expect(canvasArrowDirection(changed.edges[0])).toBe(direction);
  if(direction!=="end")expect(changed.edges[0]).toMatchObject({fromEnd,toEnd,extra:{keep:true}});
  expect(parseCanvas(serializeCanvas(changed))).toEqual(changed);
 }
 const side=changeCanvasEdgeSide(data,"edge","from","top");expect(side.edges[0].fromSide).toBe("top");expect(parseCanvas(serializeCanvas(changeCanvasEdgeSide(side,"edge","from","auto"))).edges[0].fromSide).toBeUndefined();
 expect(nearestCanvasSide(data.nodes[0],{x:50,y:1})).toBe("top");expect(nearestCanvasSide(data.nodes[0],{x:99,y:40})).toBe("right");
});

it("重新连接保留边属性，拒绝自环及新增重复连接",()=>{
 const data=fixture(),next=reconnectCanvasEdge(data,"edge","to","c","left");
 expect(next.edges[0]).toEqual({...data.edges[0],toNode:"c",toSide:"left"});expect(next.nodes).toBe(data.nodes);expect(next.extra).toBe("保留");
 expect(reconnectCanvasEdge(data,"edge","from","c","right").edges[0]).toEqual({...data.edges[0],fromNode:"c",fromSide:"right"});
 expect(reconnectCanvasEdge(data,"edge","to","a","left")).toBe(data);expect(reconnectCanvasEdge(data,"edge","to","missing","left")).toBe(data);
 expect(reconnectCanvasEdge(data,"edge","to","b","left")).toBe(data);
 const duplicate={...data,edges:[...data.edges,{id:"second",fromNode:"a",toNode:"c"}]};expect(()=>reconnectCanvasEdge(duplicate,"edge","to","c","left")).toThrow(/已连接/);
 const existingDuplicate={...data,edges:[...data.edges,{id:"second",fromNode:"a",toNode:"b"}]};expect(reconnectCanvasEdge(existingDuplicate,"edge","to","b","top").edges[0].toSide).toBe("top");
});
