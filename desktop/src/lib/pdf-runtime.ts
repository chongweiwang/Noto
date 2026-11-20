export type PdfLibrary = typeof import("pdfjs-dist");

export function createPdfTask(library: PdfLibrary, data: string, canvasMaxAreaInBytes = 48 * 1024 * 1024) {
  const assets = new URL("/pdfjs/", window.location.href);
  library.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", assets).href;
  return library.getDocument({
    data: Uint8Array.from(atob(data), (character) => character.charCodeAt(0)),
    cMapUrl: `${assets}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`, iccUrl: `${assets}iccs/`,
    wasmUrl: `${assets}wasm/`, useWasm: false, enableXfa: false, disableWorkerRendering: true,
    canvasMaxAreaInBytes,
  });
}
