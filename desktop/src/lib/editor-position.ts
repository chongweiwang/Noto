export type EditorPosition = { from: number; line: number; column: number };

export function createEditorPositions() {
  const positions = new Map<string, EditorPosition>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    get(path: string) { return positions.get(path); },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(path: string, next: EditorPosition) {
      const current = positions.get(path);
      if (current?.from === next.from && current.line === next.line && current.column === next.column) return;
      positions.set(path, next);
      notify();
    },
    clear() { positions.clear(); notify(); },
  };
}

export type EditorPositions = ReturnType<typeof createEditorPositions>;
