import {canvasBytes,maxCanvasBytes,maxCanvasHistoryBytes,maxCanvasHistorySteps,maxCanvasNodes,type CanvasData,type CanvasHistory} from "./canvas-document";

type CapacityWarning={key:"nodes"|"bytes"|"history";message:string};
const mib=(bytes:number)=>(bytes/(1024*1024)).toFixed(2);
const warningRatio=.8;

export function canvasCapacityWarnings(data:CanvasData,source:string,history:CanvasHistory,historyTrimmed:boolean):CapacityWarning[]{
  const warnings:CapacityWarning[]=[];
  if(data.nodes.length>=maxCanvasNodes*warningRatio)warnings.push({key:"nodes",message:`画布节点接近上限：${data.nodes.length}/${maxCanvasNodes}，可考虑拆分画布。`});
  const bytes=canvasBytes(source);
  // The shared file API normalizes newlines and removes a UTF-8 BOM on read.
  // Account for the largest possible restored CRLF/BOM representation on save.
  let newlines=0;
  for(let i=0;i<source.length;i++)if(source[i]==="\n"||source[i]==="\r"&&source[i+1]!=="\n")newlines++;
  const possibleFileBytes=bytes+newlines+3;
  if(possibleFileBytes>=maxCanvasBytes*warningRatio)warnings.push({key:"bytes",message:`画布文件接近大小上限：当前内容约 ${mib(bytes)}/4 MiB，考虑文件格式后最多约 ${mib(possibleFileBytes)} MiB。`});
  const steps=history.past.length,historyBytes=history.past.reduce((total,step)=>total+step.bytes,0);
  const near=steps>=maxCanvasHistorySteps*warningRatio||historyBytes>=maxCanvasHistoryBytes*warningRatio||steps>0&&historyBytes+2*bytes>maxCanvasHistoryBytes;
  if(near||historyTrimmed){
    const state=`撤销历史：${steps}/${maxCanvasHistorySteps} 步，约 ${mib(historyBytes)}/20 MiB。`;
    warnings.push({key:"history",message:state+(historyTrimmed?"较早的撤销记录已因上限移除。":near?"接近上限，继续编辑可能移除较早记录。":"")});
  }
  return warnings;
}
