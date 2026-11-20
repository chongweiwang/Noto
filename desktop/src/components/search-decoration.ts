import {StateEffect,StateField} from "@codemirror/state";
import {Decoration,EditorView} from "@codemirror/view";
export type EditorSearchMark={from:number;to:number;serial:number};
export const searchMarkEffect=StateEffect.define<EditorSearchMark|null>();
export const editorSearchMark=StateField.define<EditorSearchMark|null>({
 create:()=>null,
 update(value,tr){
  const effect=tr.effects.find(item=>item.is(searchMarkEffect));
  if(effect)return effect.value;
  return tr.docChanged||tr.selection?null:value;
 },
 provide:field=>EditorView.decorations.from(field,value=>value&&value.from<value.to?Decoration.set([Decoration.mark({class:"cm-vault-search-hit","data-search-hit":String(value.serial)}).range(value.from,value.to)]):Decoration.none),
});
