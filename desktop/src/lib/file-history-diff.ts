export interface HistoryDiffLine { kind: "same" | "add" | "remove"; text: string }
// Bound both the comparison cost and the rendered output. Restoration always uses
// the complete snapshot, even when the preview has been shortened.
export function historyDiff(before: string, after: string) {
  const split = (text: string) => text.replace(/\r\n?/g, "\n").split("\n", 5001);
  const a = split(before), b = split(after);
  let limited = a.length > 5000 || b.length > 5000;
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const lines: HistoryDiffLine[] = [];
  let chars = 0;
  function emit(kind: HistoryDiffLine["kind"], text: string) {
    if (lines.length >= 1000 || chars >= 120000) { limited = true; return; }
    const shortened = text.slice(0, Math.min(4000, 120000 - chars));
    if (shortened.length !== text.length) limited = true;
    lines.push({ kind, text: shortened }); chars += shortened.length;
  }
  function context(start:number,end:number) {
    if(end-start<=8){for(let i=start;i<end;i++)emit("same",a[i]);return;}
    for(let i=start;i<start+3;i++)emit("same",a[i]);
    emit("same",`… 省略 ${end-start-6} 行相同内容 …`);
    for(let i=end-3;i<end;i++)emit("same",a[i]);
  }
  context(0,prefix);
  if ((left.length + 1) * (right.length + 1) <= 250000) {
    const width = right.length + 1, table = new Uint16Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
      table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { emit("same", left[i++]); j++; }
      else if (j >= right.length || i < left.length && table[(i + 1) * width + j] >= table[i * width + j + 1]) emit("remove", left[i++]);
      else emit("add", right[j++]);
    }
  } else {
    limited = true;
    left.forEach(line => emit("remove", line)); right.forEach(line => emit("add", line));
  }
  context(a.length-suffix,a.length);
  return { lines, limited };
}
