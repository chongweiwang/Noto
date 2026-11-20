import { analyzeEditorMarkdown } from "./editor-markdown-index";

self.onmessage = ({ data }: MessageEvent<string>) => {
  try {
    analyzeEditorMarkdown(data, message => self.postMessage(message), true);
  } catch {
    self.postMessage({ type: "error" });
  }
};
