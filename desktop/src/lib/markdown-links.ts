export function decodeLink(link: string): string {
  try { return decodeURIComponent(link); } catch { return link; }
}

// Resolve Markdown links within the vault; never permit an absolute path or
// traversal above its root. The Rust adapter verifies paths again on access.
export function resolveNoteLink(note: string, link: string): string | null {
  const decoded = decodeLink(link).replaceAll("\\", "/");
  if (!decoded || decoded.startsWith("/") || decoded.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  const parts = note.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}
