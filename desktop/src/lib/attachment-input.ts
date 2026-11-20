export const maxDroppedAttachmentBytes = 16 * 1024 * 1024;
export function attachmentMarkdown(relative: string): string {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  const label = name.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const encoded = relative.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  return `${/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name) ? "!" : ""}[${label}](${encoded})`;
}
export function readAttachment(file: File): Promise<Uint8Array> {
  if (file.size > maxDroppedAttachmentBytes) return Promise.reject(new Error("粘贴或拖入附件上限为 16 MB，请使用导入附件"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("无法读取附件，请重新选择"));
    reader.readAsArrayBuffer(file);
  });
}
