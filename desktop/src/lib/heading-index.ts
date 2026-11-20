import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import type {Root as MarkdownRoot} from "mdast";
import type {Root,RootContent} from "hast";
import {remarkWikiLinks,type WikiLink} from "./wiki-syntax";
import {remarkDisplayMath} from "./rich-markdown";
import {headingBase,rehypeHeadingIds,textOf} from "./heading-ids";

export type HeadingEntry={id:string;text:string;level:number;from:number;line:number;parent:number|null};
// Same lightweight semantics/order as preview and export, before math/diagram rendering.
const processor=unified().use(remarkParse).use(remarkGfm).use(remarkMath)
 .use(remarkDisplayMath).use(remarkWikiLinks).use(remarkRehype).use(rehypeHeadingIds);
export function headingIndex(source:string,tree?:MarkdownRoot,wikiLinks?:WikiLink[]):HeadingEntry[]{
 const html=processor.runSync(tree??processor.parse(source),{value:source,data:{notoWikiLinks:wikiLinks}}) as Root;
 const result:HeadingEntry[]=[],stack:number[]=[];
 function visit(node:RootContent){
  if(node.type!=="element")return;
  const level=/^h([1-6])$/.exec(node.tagName),from=node.position?.start.offset;
  if(level&&from!==undefined){
   const depth=Number(level[1]);
   while(stack.length&&result[stack.at(-1)!].level>=depth)stack.pop();
   result.push({id:String(node.properties.id),text:textOf(node).trim()||"无标题",level:depth,from,line:node.position!.start.line,parent:stack.at(-1)??null});
   stack.push(result.length-1);
  }
  node.children.forEach(visit);
 }
 html.children.forEach(visit);return result;
}
export function findHeading(headings:HeadingEntry[],fragment:string){
 const input=fragment.trim();if(!input||input.startsWith("^"))return undefined;
 return headings.find(heading=>heading.id===input)??headings.find(heading=>heading.id===headingBase(input));
}
