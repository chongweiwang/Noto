import {expect,it} from "vitest";
import {collectSearch,resolveSearchHit} from "./note-search";
it("千篇多命中与长文上限模型保留精确位置和取消边界",async()=>{
 const notes=Array.from({length:1000},(_,i)=>({path:"资料/"+i+".md",version:"v1",content:"# 笔记 "+i+"\n\n重复目标，另一处重复目标。\n\n"+("正文 ".repeat(20))}));
 const started=performance.now(),all=await collectSearch("重复目标",notes,notes.map(n=>n.path)),allMs=Math.round(performance.now()-started);
 expect(all).toMatchObject({hits:2000,truncated:false,unscanned:0});expect(all!.files).toHaveLength(1000);
 const file=all!.files[23],hit=file.hits[1];expect(file.note!.content.slice(hit.from,hit.to)).toBe("重复目标");
 expect(resolveSearchHit(file.note!,hit,"前插内容\n\n"+file.note!.content,"重复目标")).toEqual({from:hit.from+6,to:hit.to+6});
 const long={path:"长文.md",version:"v1",content:("中文😀 "+ "前".repeat(900)+"命中\n").repeat(1000)},at=performance.now(),bounded=await collectSearch("命中",[long],[long.path]),longMs=Math.round(performance.now()-at);
 expect(bounded).toMatchObject({hits:200,truncated:true});expect(bounded!.files[0].hits.every(h=>long.content.slice(h.from,h.to)==="命中")).toBe(true);
 console.info("search-hit-scale",JSON.stringify({notes:1000,hits:2000,allMs,longUtf16:long.content.length,longHitsCollected:200,longMs,measurement:"CLI model; no browser/WebView frame rate"}));
},30000);
