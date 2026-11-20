import {RangeSetBuilder} from "@codemirror/state";
import {Decoration,EditorView,ViewPlugin,type DecorationSet,type ViewUpdate} from "@codemirror/view";
import {blocksForDoc,findBlock} from "../lib/wiki-block";

function markers(view:EditorView):DecorationSet{
 const builder=new RangeSetBuilder<Decoration>(),index=blocksForDoc(view.state.doc),ranges:{from:number;to:number}[]=[];
 for(const block of index.blocks){
  if(block.markers.length!==1||findBlock(index,block.markers[0].id).status!=="resolved")continue;
  const marker=block.markers[0],line=view.state.doc.lineAt(marker.from);
  if(view.state.selection.ranges.some(range=>range.from<=block.to&&range.to>=block.from||range.from<=line.to&&range.to>=line.from))continue;
  if(marker.to<view.viewport.from||marker.from>view.viewport.to)continue;
  const from=!marker.standalone&&marker.from>0&&/[ \t]/.test(view.state.sliceDoc(marker.from-1,marker.from))?marker.from-1:marker.from;
  ranges.push({from,to:marker.to});
 }
 for(const range of ranges.sort((a,b)=>a.from-b.from))builder.add(range.from,range.to,Decoration.replace({}));
 return builder.finish();
}
export const blockMarkers=ViewPlugin.fromClass(class{
 decorations:DecorationSet;
 constructor(view:EditorView){this.decorations=markers(view);}
 update(update:ViewUpdate){if(update.docChanged||update.selectionSet||update.viewportChanged)this.decorations=markers(update.view);}
},{decorations:plugin=>plugin.decorations});
