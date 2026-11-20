// The editor renderers and theme are adapted from Noteriv; see third_party/noteriv/LICENSE.
import { registerBlockRenderer, registerInlineRenderer } from "./registry";
import { headingRenderer } from "./renderers/headings";
import { horizontalRuleRenderer } from "./renderers/horizontal-rule";
import { blockquoteRenderer } from "./renderers/blockquotes";
import { checkboxRenderer } from "./renderers/checkboxes";
import { unorderedListRenderer, orderedListRenderer } from "./renderers/lists";
import { tableRenderer } from "./renderers/tables";
import { inlineRenderers } from "./renderers/inline";
import { imageRenderer } from "./renderers/images";

for (const renderer of [horizontalRuleRenderer, headingRenderer, blockquoteRenderer, checkboxRenderer, unorderedListRenderer, orderedListRenderer, tableRenderer]) {
  registerBlockRenderer(renderer);
}
registerInlineRenderer(imageRenderer);
for (const renderer of inlineRenderers) registerInlineRenderer(renderer);

export { liveMarkdownPlugin } from "./plugin";
export { markdownRenderTheme, mdHighlightStyle, editorTheme } from "./theme";
export { notePathFacet } from "./context";
