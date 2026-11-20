import { isMarkdown } from "./document-kind";

// UI placement only: a document keeps one session and one mounted editor.
export interface NotePanes {
  right: string[];
  leftActive: string | null;
  rightActive: string | null;
  ratio: number;
}

export function normalizeNotePanes(value: unknown, tabs: string[], active: string | null): NotePanes {
  const data = value && typeof value === "object" ? value as Partial<NotePanes> : {};
  const right = tabs.filter(path => isMarkdown(path) && Array.isArray(data.right) && data.right.includes(path));
  const left = tabs.filter(path => !right.includes(path));
  return {
    right,
    leftActive: active && left.includes(active) ? active : data.leftActive === null ? null : left.includes(data.leftActive ?? "") ? data.leftActive! : left[0] ?? null,
    rightActive: active && right.includes(active) ? active : right.includes(data.rightActive ?? "") ? data.rightActive! : right[0] ?? null,
    ratio: typeof data.ratio === "number" && Number.isFinite(data.ratio) ? Math.max(.25, Math.min(.75, data.ratio)) : .5,
  };
}

export function remapNotePanes(panes: NotePanes, map: (path: string) => string): NotePanes {
  return { ...panes, right: panes.right.map(map), leftActive: panes.leftActive && map(panes.leftActive), rightActive: panes.rightActive && map(panes.rightActive) };
}
