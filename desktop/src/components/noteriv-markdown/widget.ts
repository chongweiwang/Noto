import { WidgetType, type EditorView } from "@codemirror/view";
import { sanitizeHtml } from "../../lib/sanitize-html";
import { notePathFacet, assetApiFacet } from "./context";
import { previewImage } from "../../lib/ui-actions";

/**
 * A CodeMirror widget that renders HTML inline.
 *
 * Most callers pass markup this module generated itself, but the raw HTML block
 * renderer passes note content straight through, so everything is sanitized
 * here at the single point where it reaches the document.
 */
export class RenderedMarkdownWidget extends WidgetType {
  constructor(readonly html: string, readonly className: string) {
    super();
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.className;
    span.innerHTML = sanitizeHtml(this.html);
    span.querySelectorAll<HTMLImageElement>("img[data-local-src]").forEach((image) => {
      const raw = image.dataset.localSrc || "";
      const opener = document.createElement("span"); opener.className = "markdown-image-open"; opener.tabIndex = 0; opener.setAttribute("role", "button"); opener.setAttribute("aria-label", `查看图片 ${image.alt || raw}`); opener.title = "点击放大";
      image.replaceWith(opener); opener.append(image);
      opener.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      opener.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); previewImage(image.src, image.alt || raw); });
      opener.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); previewImage(image.src, image.alt || raw); } });
      let link = raw;
      try { link = decodeURIComponent(raw); } catch { /* Invalid escapes remain a failed path. */ }
      const note = view.state.facet(notePathFacet);
      if (note) view.state.facet(assetApiFacet).image(note, link).then((data) => { if (image.isConnected) image.src = data; })
        .catch(() => { image.alt = `${image.alt || raw}（无法读取图片）`; });
    });
    return span;
  }
  ignoreEvent(e: Event) {
    if ((e.target as Element | null)?.closest?.(".markdown-image-open")) return true;
    // Let images handle their own clicks (for resize/select)
    if (this.className === "md-image") return true;
    // Let click events through for interactive elements (wikilinks, links, etc)
    if (e.type === "mousedown") {
      const target = e.target as HTMLElement;
      if (target.closest(".md-img-wrapper")) return true;
    }
    return false;
  }
}
