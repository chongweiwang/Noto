export const exportPapers = {
  A4: [210, 297],
  A5: [148, 210],
  letter: [215.9, 279.4],
} as const;
export const exportMargins = [12, 20, 25] as const;
export const exportFontSizes = [14, 16, 18] as const;
export const exportPresetNameLimit = 40;

export interface ExportPreset {
  name: string;
  format: "html" | "pdf";
  paper: keyof typeof exportPapers;
  orientation: "portrait" | "landscape";
  margin: typeof exportMargins[number];
  fontSize: typeof exportFontSizes[number];
}

export const standardExportPreset: ExportPreset = {
  name: "", format: "html", paper: "A4", orientation: "portrait", margin: 20, fontSize: 16,
};
export const standardExportLabel = "标准（内置）";
export const normalizeExportPresetName = (name: string) => name.trim().normalize("NFC");

export function normalizeExportPresets(value: unknown): ExportPreset[] {
  if (!Array.isArray(value)) return [];
  const presets: ExportPreset[] = [];
  const names = new Set([standardExportLabel.toLowerCase()]);
  for (const candidate of value as unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    if (typeof item.name !== "string") continue;
    const name = normalizeExportPresetName(item.name);
    const key = name.toLowerCase();
    if (!name || name.length > exportPresetNameLimit || names.has(key)) continue;
    names.add(key);
    presets.push({
      name,
      format: item.format === "pdf" ? "pdf" : "html",
      paper: item.paper === "A5" || item.paper === "letter" ? item.paper : "A4",
      orientation: item.orientation === "landscape" ? "landscape" : "portrait",
      margin: item.margin === 12 || item.margin === 25 ? item.margin : 20,
      fontSize: item.fontSize === 14 || item.fontSize === 18 ? item.fontSize : 16,
    });
  }
  return presets;
}
