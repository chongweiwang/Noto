"use client";

import { useState } from "react";
import {
  exportFontSizes, exportMargins, exportPapers, exportPresetNameLimit,
  normalizeExportPresetName, standardExportLabel, standardExportPreset, type ExportPreset,
} from "../lib/export-presets";

type PresetSettings = { exportPresets: ExportPreset[]; defaultExportPreset: string };

export function ExportPresetSettings({ presets, defaultName, onChange }: {
  presets: ExportPreset[];
  defaultName: string;
  onChange: (settings: PresetSettings) => void;
}) {
  const [selected, setSelected] = useState(defaultName);
  const [draft, setDraft] = useState<ExportPreset | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const preset = presets.find(item => item.name === selected) ?? standardExportPreset;

  function openDraft(create: boolean) {
    setCreating(create);
    setDraft({ ...preset, name: create ? "" : preset.name });
    setError("");
  }

  function savePreset(value: ExportPreset) {
    const name = normalizeExportPresetName(value.name);
    const key = name.toLowerCase();
    if (!name) { setError("请输入预设名称。"); return; }
    if (name.length > exportPresetNameLimit) { setError("预设名称过长。"); return; }
    if (key === standardExportLabel.toLowerCase() || presets.some(item =>
      (creating || item.name !== preset.name) && item.name.toLowerCase() === key)) {
      setError("这个预设名称已存在。");
      return;
    }
    const next = { ...value, name };
    onChange({
      exportPresets: creating ? [...presets, next] : presets.map(item => item.name === preset.name ? next : item),
      defaultExportPreset: !creating && defaultName === preset.name ? name : defaultName,
    });
    setSelected(name);
    setDraft(null);
  }

  function deletePreset() {
    const nextDefault = defaultName === preset.name ? "" : defaultName;
    onChange({ exportPresets: presets.filter(item => item.name !== preset.name), defaultExportPreset: nextDefault });
    setSelected(nextDefault);
    setDraft(null);
  }

  return <section className="export-preset-settings" aria-label="导出预设">
    <h4>导出预设</h4>
    {draft ? <form onSubmit={event => { event.preventDefault(); savePreset(draft); }}>
      <div className="export-preset-fields">
        <label className="preset-name-field">预设名称<input autoFocus maxLength={exportPresetNameLimit} value={draft.name} onChange={event => { setDraft({ ...draft, name: event.target.value }); setError(""); }}/></label>
        <label>首选输出<select value={draft.format} onChange={event => setDraft({ ...draft, format: event.target.value as ExportPreset["format"] })}>
          <option value="html">HTML</option><option value="pdf">打印 / PDF</option>
        </select></label>
        <label>纸张<select value={draft.paper} onChange={event => setDraft({ ...draft, paper: event.target.value as ExportPreset["paper"] })}>
          {Object.keys(exportPapers).map(paper => <option key={paper} value={paper}>{paper === "letter" ? "Letter" : paper}</option>)}
        </select></label>
        <label>方向<select value={draft.orientation} onChange={event => setDraft({ ...draft, orientation: event.target.value as ExportPreset["orientation"] })}>
          <option value="portrait">纵向</option><option value="landscape">横向</option>
        </select></label>
        <label>页边距<select value={draft.margin} onChange={event => setDraft({ ...draft, margin: Number(event.target.value) as ExportPreset["margin"] })}>
          {exportMargins.map(size => <option key={size} value={size}>{size} mm</option>)}
        </select></label>
        <label>正文字号<select value={draft.fontSize} onChange={event => setDraft({ ...draft, fontSize: Number(event.target.value) as ExportPreset["fontSize"] })}>
          {exportFontSizes.map(size => <option key={size} value={size}>{size} px</option>)}
        </select></label>
      </div>
      {error && <p className="export-preset-error" role="alert">{error}</p>}
      <div className="export-preset-buttons">
        <button type="submit" className="primary">保存预设</button>
        <button type="button" onClick={() => setDraft(null)}>取消</button>
        {!creating && <button type="button" className="preset-delete" onClick={deletePreset}>删除预设</button>}
      </div>
    </form> : <>
      <label className="export-preset-select">选择预设<select value={preset.name} onChange={event => setSelected(event.target.value)}>
        {[standardExportPreset, ...presets].map(item => <option key={item.name} value={item.name}>
          {item.name || standardExportLabel}{item.name === defaultName ? " · 默认" : ""}
        </option>)}
      </select></label>
      <p className="export-preset-details">{preset.format === "pdf" ? "打印 / PDF" : "HTML"} · {preset.paper === "letter" ? "Letter" : preset.paper} {preset.orientation === "landscape" ? "横向" : "纵向"} · {preset.margin} mm · {preset.fontSize} px</p>
      <div className="export-preset-buttons">
        <button type="button" onClick={() => openDraft(true)}>新建预设</button>
        <button type="button" disabled={!preset.name} onClick={() => openDraft(false)}>编辑预设</button>
        <button type="button" disabled={preset.name === defaultName} onClick={() => onChange({ exportPresets: presets, defaultExportPreset: preset.name })}>设为默认</button>
      </div>
    </>}
  </section>;
}
