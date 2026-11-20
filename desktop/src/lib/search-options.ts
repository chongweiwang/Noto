import { RE2JS } from "re2js";
import { matchesNoteTags, noteProperties, parseTagFilters, type TagMatchMode } from "./note-tags";
import type { Note } from "./vault-api";

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  folder?: string;
  tag?: string;
  tagMode?: TagMatchMode;
  property?: string;
}

function matcher(query: string, options: SearchOptions) {
  if (query.length > 500) throw new Error("正则表达式最多 500 个字符");
  return RE2JS.compile(query, RE2JS.MULTILINE | (options.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE));
}

export function createSearchMatcher(query: string, options: SearchOptions = {}) {
  if (options.regex) {
    const expression = matcher(query, options);
    return function* (content: string) {
      const match = expression.matcher(content);
      while (match.find()) {
        const from = match.start(), to = match.end();
        if (to > from) yield { from, to, group: (index: number) => index <= match.groupCount() ? match.group(index) : undefined };
      }
    };
  }
  const source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return function* (content: string) {
    const expression = new RegExp(source, options.caseSensitive ? "gu" : "giu");
    for (const match of content.matchAll(expression)) {
      const from = match.index;
      yield { from, to: from + match[0].length, group: (index: number) => match[index] };
    }
  };
}

export function matchesSearchFilters(path: string, note: Note | undefined, options: SearchOptions) {
  if (options.folder && !path.startsWith(options.folder.replace(/\/+$/, "") + "/")) return false;
  const tags = parseTagFilters(options.tag ?? "");
  const property = options.property?.trim();
  if (!tags.length && !property) return true;
  if (!note) return false;
  if (property) {
    const fields = noteProperties(note);
    const [key, expected] = property.split(/=(.*)/s, 2).map((value) => value.trim());
    if (!Object.hasOwn(fields, key)) return false;
    const values = Array.isArray(fields[key]) ? fields[key] : [fields[key]];
    if (expected !== undefined && !values.some((value) => value != null && typeof value !== "object" && String(value).toLowerCase() === expected.toLowerCase())) return false;
  }
  return matchesNoteTags(note, tags, options.tagMode);
}

export function replaceSearchMatches(content: string, query: string, options: SearchOptions, replacement: string) {
  if (!query) return content;
  let last = 0;
  const output: string[] = [];
  for (const match of createSearchMatcher(query, options)(content)) {
    const next = options.regex ? replacement.replace(/\$([$&]|[1-9][0-9]?)/g, (token, key: string) => {
      if (key === "$") return "$";
      const group = match.group(key === "&" ? 0 : Number(key));
      return group === undefined ? token : group ?? "";
    }) : replacement;
    output.push(content.slice(last, match.from), next);
    last = match.to;
  }
  output.push(content.slice(last));
  return output.join("");
}
