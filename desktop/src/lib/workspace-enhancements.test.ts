import { describe, expect, it } from "vitest";
import { collectSearch, resolveSearchHit } from "./note-search";
import { replaceSearchMatches } from "./search-options";
import { splitSlides } from "./slides";
import { prepareMergedNoteExport, type ExportSnapshot } from "./note-export";

describe("advanced search and workspace exports", () => {
  it("matches Unicode offsets and filters YAML properties and nested tags", async () => {
    const source = {path:"项目/一.md",version:"v1",content:"---\nstatus: open\ntags: [study/pdf]\n---\n😀第12页\n第34页"};
    const other = {...source,path:"其他/二.md"};
    const query = "第([0-9]+)页";
    const options = {regex:true,folder:"项目",tag:"study",property:"status=open"};
    const result=await collectSearch(query,[source,other],[source.path,other.path],()=>false,options);
    expect(result?.files.map(file=>file.path)).toEqual([source.path]);
    const hits=result!.files[0].hits;
    expect(hits.map(hit=>source.content.slice(hit.from,hit.to))).toEqual(["第12页","第34页"]);
    expect(resolveSearchHit(source,hits[0],"新增\n"+source.content,query,options)?.from).toBe(hits[0].from+3);
    expect(replaceSearchMatches(source.content,query,options,"P$1")).toContain("😀P12\nP34");
    await expect(collectSearch("[", [source], [source.path], () => false, options)).rejects.toThrow();
  });

  it("splits top-level Markdown slides while preserving fenced dividers and speaker notes",()=>{
    const slides=splitSlides("---\ntitle: Demo\n---\n# One\n\n```md\n---\n```\n\n---\n\n# Two\n\n<!-- notes -->\nSay this.");
    expect(slides).toHaveLength(2);
    expect(slides[0].content).toContain("```md\n---\n```");
    expect(slides[1]).toEqual({content:"# Two",notes:"Say this."});
  });

  it("merges safely scoped notes with working cross-note links and collapsible callouts",async()=>{
    const snapshot=(path:string, content:string):ExportSnapshot=>({path,content,paths:["one.md","two.md"],drawingPaths:[],capturedAt:0,unsaved:false,conflict:false});
    const report=await prepareMergedNoteExport([
      snapshot("one.md","# Example\n\n[Second](two.md#example)\n\n> [!TIP]- **Custom**\n> Useful text"),
      snapshot("two.md","# Example\n\n[[one#Example]]"),
    ],{image:async()=>{throw new Error("unexpected image");}});
    expect(report.warnings).toEqual([]);
    expect(report.html).toContain('id="note-1-example"');
    expect(report.html).toContain('id="note-2-example"');
    expect(report.html).toContain('href="#note-2-example"');
    expect(report.html).toContain('href="#note-1-example"');
    expect(report.html).toContain('<details class="markdown-callout callout-tip">');
    expect(report.html).toContain('<summary class="callout-title"><strong>Custom</strong></summary>');
    expect(report.html).toContain("<p>Useful text</p>");
  });
});
