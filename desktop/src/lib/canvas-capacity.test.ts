import {expect,it} from "vitest";
import {canvasCapacityWarnings} from "./canvas-capacity";
import {CanvasHistory,canvasBytes,maxCanvasBytes,maxCanvasHistoryBytes,type CanvasData} from "./canvas-document";

const data=(count:number):CanvasData=>({nodes:Array.from({length:count},(_,i)=>({id:String(i),type:"text",x:0,y:0,width:1,height:1,text:""})),edges:[]});
const keys=(warnings:ReturnType<typeof canvasCapacityWarnings>)=>warnings.map(w=>w.key);

it("节点和 UTF-8 内容在接近上限前后分别提示",()=>{
 const history=new CanvasHistory(),threshold=Math.ceil(maxCanvasBytes*.8),prefix='{"nodes":[],"edges":[],"extra":"',suffix='"}';
 const below=prefix+"x".repeat(threshold-canvasBytes(prefix+suffix)-4)+suffix;
 const near=prefix+"中".repeat(Math.ceil((threshold-canvasBytes(prefix+suffix))/3))+suffix;
 expect(keys(canvasCapacityWarnings(data(799),below,history,false))).toEqual([]);
 expect(keys(canvasCapacityWarnings(data(800),near,history,false))).toEqual(["nodes","bytes"]);
 expect(canvasCapacityWarnings(data(800),near,history,false)[1].message).toContain("4 MiB");
});

it("按 CRLF 和 BOM 的保守大小提醒，避免归一化换行低估文件",()=>{
 const source="\n".repeat(1_700_000)+'{"nodes":[],"edges":[]}';
 expect(canvasBytes(source)).toBeLessThan(maxCanvasBytes*.8);
 expect(canvasCapacityWarnings(data(0),source,new CanvasHistory(),false).find(w=>w.key==="bytes")?.message).toContain("考虑文件格式后");
});

it("撤销步数在达到 40 步时提醒，撤销和重做后更新，实际丢弃也可识别",()=>{
 const history=new CanvasHistory();
 for(let i=0;i<39;i++)expect(history.record(String(i),String(i+1))).toBe(0);
 expect(keys(canvasCapacityWarnings(data(0),"{}",history,false))).toEqual([]);
 history.record("39","40");expect(canvasCapacityWarnings(data(0),"{}",history,false)[0].message).toContain("40/50");
 expect(history.undo("40")).toBe("39");expect(keys(canvasCapacityWarnings(data(0),"{}",history,false))).toEqual([]);
 expect(history.redo("39")).toBe("40");
 for(let i=40;i<50;i++)expect(history.record(String(i),String(i+1))).toBe(0);
 expect(history.record("50","51")).toBe(1);expect(history.past).toHaveLength(50);
 expect(canvasCapacityWarnings(data(0),"{}",history,true)[0].message).toContain("较早的撤销记录已因上限移除");
 expect(history.undo("51")).toBe("50");expect(history.redo("50")).toBe("51");
});

it("大画布按下一步快照估计，在历史预算达到 80% 前预警",()=>{
 const history=new CanvasHistory(),content="a".repeat(3_700_000);
 history.record(content,content+"1");history.record(content+"1",content+"2");
 const used=history.past.reduce((total,step)=>total+step.bytes,0);
 expect(used).toBeLessThan(maxCanvasHistoryBytes*.8);
 expect(canvasCapacityWarnings(data(0),content+"2",history,false).find(w=>w.key==="history")?.message).toContain("继续编辑可能移除较早记录");
 expect(history.record(content+"2",content+"3")).toBe(1);expect(history.undo(content+"3")).toBe(content+"2");
});
