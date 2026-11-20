// Date handling follows the local-calendar approach used by Noteriv.
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => new Date(year, month, 1 - mondayOffset + index));
}

export const dailyFolder = "日记";
export function dailyPath(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsed = new Date(`${date}T12:00:00`);
  if (!match || Number.isNaN(parsed.getTime()) || localDate(parsed) !== date) throw new Error("日记日期无效");
  return `${dailyFolder}/${match[1]}/${match[2]}/${date}.md`;
}

export function dateFromDailyPath(path: string): string | null {
  if (!path.startsWith(`${dailyFolder}/`)) return null;
  const date = /\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1];
  if (!date) return null;
  try { return dailyPath(date) === path ? date : null; }
  catch { return null; }
}

export function calendarHeatmapDays(today: Date) {
  const year = today.getFullYear(), month = today.getMonth(), day = today.getDate();
  const first = new Date(year, month, day - 364, 12);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 365 }, (_, index) => ({
    date: localDate(new Date(year, month, day - 364 + index, 12)),
    week: Math.floor((index + offset) / 7),
    weekday: (index + offset) % 7,
  }));
}
