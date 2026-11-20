import type { Entry } from "../lib/desktop-api";

export function vaultEntries(files: Iterable<string>, folders: Iterable<string> = []): Entry[] {
  const roots: Entry[] = [], index = new Map<string, Entry>();
  function add(path: string, directory: boolean) {
    if (path.split("/").some((part) => part.startsWith("."))) return;
    if (index.has(path)) return;
    const at = path.lastIndexOf("/"), parent = at < 0 ? "" : path.slice(0, at);
    if (parent) add(parent, true);
    const entry = { path, name: path.slice(at + 1), isDirectory: directory, children: [] };
    index.set(path, entry);
    (parent ? index.get(parent)!.children : roots).push(entry);
  }
  for (const path of folders) add(path, true);
  for (const path of files) add(path, false);
  return roots;
}
