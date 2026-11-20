import type { WorkspaceApi } from "./vault-api";
import { createPdfTask } from "./pdf-runtime";
import { createSearchMatcher, type SearchOptions } from "./search-options";
import { createSearchHit, type SearchHit } from "./note-search";
import { isPdfPath } from "./ui-actions";

export interface AttachmentHit { path: string; page?: number; match: SearchHit }
export const isTextAttachment = (path: string) => /\.(?:txt|csv|tsv|json|yaml|yml|log|xml|ini|toml|srt|vtt)$/i.test(path);

export async function searchAttachments(paths: string[], query: string, options: SearchOptions, api: WorkspaceApi, signal: AbortSignal) {
  const matches: AttachmentHit[] = [], failed: string[] = [];
  const scan = createSearchMatcher(query, options);
  const limit = 200;
  const files = paths.filter((path) =>
    (!options.folder || path.startsWith(options.folder.replace(/\/+$/, "") + "/")) && (isPdfPath(path) || isTextAttachment(path)));
  let partial = false;
  function add(path: string, text: string, page?: number) {
    for (const hit of scan(text)) {
      signal.throwIfAborted();
      if (matches.length === limit) { partial = true; break; }
      matches.push({ path, page, match: createSearchHit(text, hit) });
    }
  }
  for (const path of files) {
    signal.throwIfAborted();
    if (matches.length === limit) { partial = true; break; }
    try {
      if (isPdfPath(path) && api.readPdf) {
        const [library, file] = await Promise.all([import("pdfjs-dist"), api.readPdf(path, signal)]);
        signal.throwIfAborted();
        const task = createPdfTask(library, file.data);
        const dispose = () => { void task.destroy().catch(() => {}); };
        signal.addEventListener("abort", dispose, { once: true });
        try {
          const pdf = await task.promise;
          for (let page = 1; page <= pdf.numPages; page++) {
            signal.throwIfAborted();
            if (matches.length === limit) { partial = true; break; }
            const sheet = await pdf.getPage(page);
            const content = await sheet.getTextContent();
            add(path, content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""), page);
            sheet.cleanup();
          }
        } finally {
          signal.removeEventListener("abort", dispose);
          await task.destroy().catch(() => {});
        }
      } else if (api.readSearchText) add(path, await api.readSearchText(path, signal));
    } catch {
      signal.throwIfAborted();
      failed.push(path);
    }
  }
  return { matches, failed, partial };
}
