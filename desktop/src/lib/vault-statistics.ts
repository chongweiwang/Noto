import { documentWordCount } from "./document-info";
import { noteTags } from "./note-tags";
import type { Note } from "./vault-api";

const wordCounts = new WeakMap<Note, number>();

function savedNoteWords(note: Note): number {
  const known = wordCounts.get(note);
  if (known !== undefined) return known;
  const words = documentWordCount(note.content);
  wordCounts.set(note, words);
  return words;
}

export function summarizeVaultNotes(notes: Note[]) {
  let words = 0, taggedNotes = 0;
  const tags = new Map<string, { label: string; count: number }>();
  const lengths: { path: string; words: number }[] = [];
  for (const note of notes) {
    const count = savedNoteWords(note);
    words += count;
    if (count > 0) lengths.push({ path: note.path, words: count });
    const assigned = noteTags(note);
    if (assigned.length) taggedNotes++;
    for (const { key, label } of assigned) {
      const tag = tags.get(key);
      if (tag) tag.count++;
      else tags.set(key, { label, count: 1 });
    }
  }
  const compare = new Intl.Collator("zh-CN", { numeric: true }).compare;
  return {
    words,
    averageWords: notes.length ? Math.round(words / notes.length) : 0,
    readableNotes: notes.length,
    tags: tags.size,
    taggedNotes,
    topTags: [...tags.values()].sort((a, b) => b.count - a.count || compare(a.label, b.label)).slice(0, 5),
    longestNotes: lengths.sort((a, b) => b.words - a.words || compare(a.path, b.path)).slice(0, 5),
  };
}
