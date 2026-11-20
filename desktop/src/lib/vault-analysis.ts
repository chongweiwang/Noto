import type { Note } from "./vault-api";
import { KnowledgeIndex, referenceHasIssue, type NoteReference, type RelationIndex } from "./knowledge";
import { buildGraph, type KnowledgeGraph } from "./knowledge-graph";
import { collectSearch, type SearchFile, type SearchHit, type SearchResults } from "./note-search";
import type { SearchOptions } from "./search-options";
import { summarizeVaultNotes } from "./vault-statistics";

export type VaultQuery =
  | { kind: "search"; paths: string[]; query: string; options: SearchOptions }
  | { kind: "relations"; paths: string[]; graph: boolean }
  | { kind: "statistics"; paths: string[] };

type SearchSummary = Omit<SearchResults, "files"> & {
  files: (Omit<SearchFile, "note" | "hits"> & { hits: Omit<SearchHit, "text">[] })[];
};
export type VaultStatistics = ReturnType<typeof summarizeVaultNotes>;
export type VaultAnswer =
  | { kind: "search"; result: SearchSummary }
  | { kind: "relations"; relations: RelationIndex; graph?: KnowledgeGraph; issues: NoteReference[] }
  | { kind: "statistics"; stats: VaultStatistics };

export type VaultWorkerRequest =
  | { type: "notes"; notes: Note[]; removed: string[] }
  | { type: "query"; id: number; query: VaultQuery }
  | { type: "cancel"; id: number };
export type VaultWorkerReply =
  | { type: "result" | "progress"; id: number; answer: VaultAnswer }
  | { type: "error"; id: number; error: string };

function compact(result: SearchResults): VaultAnswer {
  return { kind: "search", result: {
    ...result,
    files: result.files.map(({ note: _note, hits, ...file }) => ({
      ...file, hits: hits.map(({ text: _text, ...hit }) => hit),
    })),
  } };
}

export function attachSearchSources(result: SearchSummary, notes: ReadonlyMap<string, Note>): SearchResults {
  return {
    ...result,
    files: result.files.map(file => {
      const note = notes.get(file.path);
      return { ...file, note, hits: file.hits.map(hit => ({
        ...hit, text: note?.content.slice(hit.from, hit.to) ?? "",
      })) };
    }),
  };
}

export class VaultAnalysis {
  private readonly notes = new Map<string, Note>();
  private readonly links = new KnowledgeIndex();

  update(notes: Note[], removed: string[]) {
    for (const path of removed) this.notes.delete(path);
    for (const note of notes) this.notes.set(note.path, note);
  }

  async run(query: VaultQuery, cancelled: () => boolean, progress?: (answer: VaultAnswer) => void): Promise<VaultAnswer | null> {
    const notes = query.paths.flatMap(path => {
      const note = this.notes.get(path);
      return note ? [note] : [];
    });
    if (query.kind === "search") {
      const result = await collectSearch(query.query, notes, query.paths, cancelled, {
        ...query.options, progress: progress && (partial => progress(compact(partial))),
      });
      return result && compact(result);
    }
    if (query.kind === "statistics") return { kind: "statistics", stats: summarizeVaultNotes(notes) };
    const relations = this.links.build(query.paths, notes);
    return {
      kind: "relations", relations,
      graph: query.graph ? buildGraph(relations) : undefined,
      issues: query.graph ? relations.references.filter(referenceHasIssue) : [],
    };
  }
}
