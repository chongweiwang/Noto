export const imagePreviewEvent = "noto-image-preview";
export const manualCopyEvent = "noto-manual-copy";
export const pdfPreviewEvent = "noto-pdf-preview";
export const isPdfPath = (path: string) => /\.pdf$/i.test(path);
export function previewPdf(path: string, fragment = "") {
  if (!isPdfPath(path)) return;
  const page = Number(/^page=(\d+)$/.exec(fragment)?.[1] ?? 1);
  window.dispatchEvent(new CustomEvent(pdfPreviewEvent, { detail: { path, page } }));
}
export function previewImage(src: string, name: string) {
  if (/^data:image\//i.test(src)) window.dispatchEvent(new CustomEvent(imagePreviewEvent, { detail: { src, name } }));
}
export async function copyText(text: string): Promise<boolean> {
  try { if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用"); await navigator.clipboard.writeText(text); return true; }
  catch { window.dispatchEvent(new CustomEvent(manualCopyEvent, { detail: text })); return false; }
}
