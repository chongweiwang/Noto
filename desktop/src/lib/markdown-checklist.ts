// Offsets come from parsed Markdown list items, never from a whole-document
// regex, so code samples and escaped checkbox text remain ordinary text.
export function checkboxOffset(source: string, itemStart: number): number | null {
  const marker = /^(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t\n]|$)/.exec(source.slice(itemStart));
  return marker ? itemStart + marker[0].indexOf("[") + 1 : null;
}

export function setMarkdownCheckbox(source: string, at: number, checked: boolean): string {
  if (!Number.isInteger(at) || source[at - 1] !== "[" || !/[ xX]/.test(source[at] ?? "") || source[at + 1] !== "]") throw new Error("任务框位置已变化，请刷新后重试");
  return source.slice(0, at) + (checked ? "x" : " ") + source.slice(at + 1);
}

export function insertMarkdownTask(source: string, from: number, to: number): { content: string; cursor: number } {
  const start = from === 0 ? 0 : source.lastIndexOf("\n", from - 1) + 1;
  const selection = source.slice(start, to);
  const lines = selection.split("\n");
  const content = source.slice(0, start) + lines.map((line) => {
    if (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\](?:\s|$)/.test(line)) return line;
    const list = /^(\s*)(?:[-+*]|\d+[.)])\s+(.*)$/.exec(line);
    return list ? `${list[1]}- [ ] ${list[2]}` : `${/^\s*/.exec(line)?.[0] ?? ""}- [ ] ${line.trimStart()}`;
  }).join("\n") + source.slice(to);
  return { content, cursor: to + content.length - source.length };
}
