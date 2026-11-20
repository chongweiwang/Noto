import { parseDocument } from "yaml";
import type { Note } from "./vault-api";
import { parseKnowledge } from "./wiki-syntax";

export type TagMatchMode = "all" | "any";
type Tag = { key: string; label: string };
type Metadata = { fields: Record<string, unknown>; body: string; tags?: Tag[] };
export type TagBranch = Tag & { children: TagBranch[]; paths: Set<string> };

const metadata = new WeakMap<Note, Metadata>();
const inlineTag = /(?:^|[\s(（【，、；：])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;

function tagName(value: string) {
  const segments = value.trim().replace(/^#/, "").normalize("NFC").split("/").map(part => part.trim());
  if (segments.some(part => !part || /[#\p{Cc}]/u.test(part))) return "";
  return segments.join("/");
}

export function parseTagFilters(value: string) {
  return [...new Set(value.split(/[,，]/).map(tagName).filter(Boolean).map(tag => tag.toLowerCase()))];
}

function noteMetadata(note: Note) {
  const known = metadata.get(note);
  if (known) return known;
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(note.content.slice(0, 16384));
  const entry: Metadata = { fields: {}, body: frontmatter ? note.content.slice(frontmatter[0].length) : note.content };
  if (frontmatter) {
    try {
      const parsed = parseDocument(frontmatter[1]);
      const value = parsed.errors.length ? null : parsed.toJS({ maxAliasCount: 0 });
      if (value && typeof value === "object" && !Array.isArray(value)) entry.fields = value;
    } catch { /* The body is still available if properties cannot be read. */ }
  }
  metadata.set(note, entry);
  return entry;
}

export function noteProperties(note: Note) {
  return noteMetadata(note).fields;
}

export function noteTags(note: Note): Tag[] {
  const entry = noteMetadata(note);
  if (entry.tags) return entry.tags;
  const tags = new Map<string, Tag>();
  function add(value: unknown) {
    if (typeof value !== "string") return;
    const label = tagName(value);
    const key = label.toLowerCase();
    if (key && !tags.has(key)) tags.set(key, { key, label });
  }
  const yamlTags = entry.fields.tags;
  if (Array.isArray(yamlTags)) yamlTags.forEach(add);
  else if (typeof yamlTags === "string") yamlTags.split(/[,\s，]+/).forEach(add);

  if (entry.body.includes("#")) {
    const { textRanges, wiki } = parseKnowledge(entry.body);
    let currentLink = 0;
    for (const { from, to } of textRanges) {
      for (const match of entry.body.slice(from, to).matchAll(inlineTag)) {
        const offset = from + match.index + match[0].length - match[1].length - 1;
        while (wiki[currentLink] && wiki[currentLink].to <= offset) currentLink++;
        if (!wiki[currentLink] || wiki[currentLink].from > offset) add(match[1]);
      }
    }
  }
  return entry.tags = [...tags.values()];
}

export function matchesNoteTags(note: Note, selected: string[], mode: TagMatchMode = "all") {
  if (!selected.length) return true;
  const tags = noteTags(note);
  const matches = (key: string) => tags.some(tag => tag.key === key || tag.key.startsWith(key + "/"));
  return mode === "all" ? selected.every(matches) : selected.some(matches);
}

export function buildTagIndex(notes: Note[]) {
  const byKey = new Map<string, TagBranch>(), roots: TagBranch[] = [];
  const taggedPaths = new Set<string>();
  for (const note of notes) {
    for (const { label } of noteTags(note)) {
      taggedPaths.add(note.path);
      let full = "";
      let branches = roots;
      for (const part of label.split("/")) {
        full += full ? "/" + part : part;
        const key = full.toLowerCase();
        let branch = byKey.get(key);
        if (!branch) {
          branch = { key, label: full, children: [], paths: new Set<string>() };
          byKey.set(key, branch);
          branches.push(branch);
        }
        branch.paths.add(note.path);
        branches = branch.children;
      }
    }
  }
  const sort = (branches: TagBranch[]) => branches.sort((a, b) => a.label.localeCompare(b.label, "zh-CN", { numeric: true }));
  sort(roots);
  for (const branch of byKey.values()) sort(branch.children);
  return { roots, byKey, taggedPaths };
}

export function matchingTagPaths(index: ReturnType<typeof buildTagIndex>, selected: string[], mode: TagMatchMode) {
  if (!selected.length) return index.taggedPaths;
  const groups = selected.map(key => index.byKey.get(key)?.paths ?? new Set<string>());
  if (mode === "any") return new Set(groups.flatMap(group => [...group]));
  const [smallest, ...others] = groups.sort((a, b) => a.size - b.size);
  return new Set([...smallest].filter(path => others.every(group => group.has(path))));
}
