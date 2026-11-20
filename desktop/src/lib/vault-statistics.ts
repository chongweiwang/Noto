import { dateFromDailyPath, localDate } from "./calendar";
import { documentWordCount } from "./document-info";
import { noteTags } from "./note-tags";
import type { Note } from "./vault-api";

const wordCounts = new WeakMap<Note, number>();

export function savedNoteWords(note: Note): number {
  const known = wordCounts.get(note);
  if (known !== undefined) return known;
  const words = documentWordCount(note.content);
  wordCounts.set(note, words);
  return words;
}

export function summarizeVaultNotes(notes: Note[]) {
  let words = 0;
  const tags = new Set<string>();
  const journal = new Map<string, { path: string; words: number }>();
  for (const note of notes) {
    const count = savedNoteWords(note);
    words += count;
    for (const tag of noteTags(note)) tags.add(tag.key);
    const date = dateFromDailyPath(note.path);
    if (date) journal.set(date, { path: note.path, words: count });
  }
  return { words, tags: tags.size, journal };
}

export type JournalTrendRange = "week" | "month" | "year";

export function journalTrend(journal: ReturnType<typeof summarizeVaultNotes>["journal"], now: Date, range: JournalTrendRange) {
  const days = range === "week" ? 7 : 30;
  const monthRange = range === "year";
  const buckets = Array.from({ length: monthRange ? 12 : days }, (_, index) => {
    const start = monthRange
      ? new Date(now.getFullYear(), now.getMonth() - 11 + index, 1)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1 + index);
    return { date: localDate(start).slice(0, monthRange ? 7 : 10), words: 0 };
  });
  const byDate = new Map(buckets.map(bucket => [bucket.date, bucket]));
  const today = localDate(now);
  for (const [date, note] of journal) {
    if (date > today) continue;
    const bucket = byDate.get(monthRange ? date.slice(0, 7) : date);
    if (bucket) bucket.words += note.words;
  }
  return buckets;
}
