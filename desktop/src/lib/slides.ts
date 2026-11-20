import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";

export function splitSlides(source: string) {
  const content = source.replace(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)\r?\n/, "");
  const root = unified().use(remarkParse).use(remarkMath).parse(content);
  const slides: { content:string; notes:string }[] = [];
  let from = 0;
  let notesAt: {start:number;end:number} | null = null;
  for (const node of [...root.children, null]) {
    if(node?.type==="html"&&node.value.trim()==="<!-- notes -->"&&!notesAt) {
      notesAt={start:node.position?.start.offset??0,end:node.position?.end.offset??0};
    }
    if(node&&node.type!=="thematicBreak") continue;
    const to=node?.position?.start.offset??content.length;
    const slide=content.slice(from,notesAt?.start??to).trim();
    if(slide)slides.push({content:slide,notes:notesAt?content.slice(notesAt.end,to).trim():""});
    from=node?.position?.end.offset??to;
    notesAt=null;
  }
  return slides.length?slides:[{content,notes:""}];
}
