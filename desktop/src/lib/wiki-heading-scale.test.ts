import {expect,it} from "vitest";
import {KnowledgeIndex} from "./knowledge";
import {headingIndex,findHeading} from "./heading-index";
import {buildGraph} from "./knowledge-graph";
it("千篇文件的标题关系维持缓存与外部变更语义，单篇千标题按模型索引",()=>{
 const files=Array.from({length:1000},(_,i)=>"笔记/"+i+".md");
 const notes=files.map((path,i)=>({path,version:"v1",content:"# 笔记 "+i+"\n\n## 重复\n\n## 重复\n\n[[笔记/"+((i+1)%files.length)+".md#重复-1|下一篇]]"}));
 const index=new KnowledgeIndex(),start=performance.now(),snapshot=index.build(files,notes),firstMs=Math.round(performance.now()-start),again=performance.now(),warm=index.build(files,notes),cachedMs=Math.round(performance.now()-again);
 expect(snapshot.references).toHaveLength(1000);expect(snapshot.references.every(link=>link.heading?.status==="resolved")).toBe(true);
 const graph=buildGraph(warm);expect(graph.nodes).toHaveLength(1000);expect(graph.edges).toHaveLength(1000);
 const changed=[...notes];changed[500]={...changed[500],content:"# 标题已变化",version:"v2"};
 expect(index.build(files,changed).references.find(link=>link.source===files[499])?.heading?.status).toBe("missing");
 const source=Array.from({length:1000},()=>"# 重复\n\n正文").join("\n\n"),at=performance.now(),headings=headingIndex(source),singleMs=Math.round(performance.now()-at);
 expect(headings).toHaveLength(1000);expect(new Set(headings.map(h=>h.id)).size).toBe(1000);expect(findHeading(headings,"重复-999")?.from).toBe(source.lastIndexOf("# 重复"));
 console.info("wiki-heading-scale",JSON.stringify({notes:1000,relations:1000,firstMs,cachedMs,singleHeadings:1000,singleMs,measurement:"CLI semantic model; no native layout/FPS"}));
},30000);
