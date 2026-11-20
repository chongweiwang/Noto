import {RangeSetBuilder} from "@codemirror/state";
import {Decoration,EditorView,ViewPlugin,type DecorationSet,type ViewUpdate} from "@codemirror/view";
import {visibleRanges} from "../lib/editor-markdown-index";
import {editorIndex,selectionTouches,shouldRender} from "./noteriv-markdown/indexed-document";

function markers(view:EditorView):DecorationSet{
 const builder=new RangeSetBuilder<Decoration>(),index=editorIndex(view.state.doc);
 if(!index)return Decoration.none;
 for(const marker of visibleRanges(index.markers,view.viewport.from,view.viewport.to)){
  const line=view.state.doc.lineAt(marker.from);
  if(selectionTouches(view.state,marker.blockFrom,marker.blockTo)||selectionTouches(view.state,line.from,line.to))continue;
  const from=!marker.standalone&&marker.from>0&&/[ \t]/.test(view.state.sliceDoc(marker.from-1,marker.from))?marker.from-1:marker.from;
  builder.add(from,marker.to,Decoration.replace({}));
 }
 return builder.finish();
}
export const blockMarkers=ViewPlugin.fromClass(class{
 decorations:DecorationSet;
 constructor(view:EditorView){this.decorations=markers(view);}
 update(update:ViewUpdate){if(shouldRender(update))this.decorations=markers(update.view);}
},{decorations:plugin=>plugin.decorations});
