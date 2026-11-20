export type SaveFeedbackInput = {
  present?: boolean; recovery?: boolean; issue?: string; conflict?: string | null;
  saving?: boolean; dirty?: boolean; failure?: string;
};

// File headers and task details describe the same protected file session.
export function saveFeedback(value: SaveFeedbackInput) {
  if (value.recovery) return { state: "recovery", label: "待确认草稿", detail: "请先恢复或丢弃草稿，自动保存已暂停。" };
  if (value.issue) return { state: "readonly", label: value.dirty ? "只读草稿" : "只读文档", detail: value.issue };
  if (value.conflict) return { state: "conflict", label: "保存需处理", detail: value.conflict };
  if (value.present === false) return { state: "ready", label: "自动保存已开启", detail: "选择文档后，编辑会在后台自动保存。" };
  if (value.saving) return { state: "saving", label: "正在保存…", detail: "保存期间可以继续编辑，后续输入会另行保存。" };
  if (value.dirty && value.failure) return { state: "failed", label: "保存失败，待重试", detail: value.failure };
  if (value.dirty) return { state: "pending", label: "待自动保存", detail: "当前编辑尚未写入文件。" };
  return { state: "saved", label: "已保存", detail: "当前内容已写入文件，不代表外部同步已完成。" };
}
