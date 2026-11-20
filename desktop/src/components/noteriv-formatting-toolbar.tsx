"use client";

import { WorkspaceIcon, type WorkspaceIconName } from "./workspace-icon";
// Adapted from Noteriv desktop/src/components/FormattingToolbar.tsx (MIT).
export type FormatAction = "heading" | "toggleBold" | "toggleItalic" | "toggleStrikethrough" | "toggleCode" | "insertLink" | "insertImage" | "insertBlockquote" | "insertCodeBlock" | "insertList" | "insertTaskList" | "insertTable" | "insertHorizontalRule";

interface FormattingToolbarProps {
  onAction: (action: FormatAction) => void;
  disabled?: boolean;
}

const actions: { action: FormatAction; label: string; shortcut?: string; content: string; className?: string; icon?: WorkspaceIconName; groupStart?: boolean }[] = [
  { action: "heading", label: "标题", content: "H1" },
  { action: "toggleBold", label: "粗体", content: "B", className: "formatting-toolbar-bold" },
  { action: "toggleItalic", label: "斜体", content: "I", className: "formatting-toolbar-italic" },
  { action: "toggleStrikethrough", label: "删除线", content: "S", className: "formatting-toolbar-strike" },
  { action: "toggleCode", label: "行内代码", content: "代码", icon: "inline-code" },
  { action: "insertLink", label: "插入链接", content: "链接", icon: "link", groupStart: true, shortcut: "Ctrl+K" },
  { action: "insertImage", label: "导入附件", content: "附件", icon: "attachment" },
  { action: "insertBlockquote", label: "引用", content: "引用", icon: "quote", groupStart: true },
  { action: "insertCodeBlock", label: "代码块", content: "代码", icon: "code-block" },
  { action: "insertList", label: "无序列表", content: "列表", icon: "list", groupStart: true },
  { action: "insertTaskList", label: "任务列表", content: "任务", icon: "checklist" },
  { action: "insertTable", label: "表格", content: "表格", icon: "table", groupStart: true },
  { action: "insertHorizontalRule", label: "分隔线", content: "分隔线", icon: "rule" },
];

export default function FormattingToolbar({ onAction, disabled }: FormattingToolbarProps) {
  return (
    <div className="formatting-toolbar" aria-label="Formatting toolbar">
      {actions.map(({ action, label, shortcut, content, className, icon, groupStart }) => (
        <button
          key={action}
          type="button"
          className={`formatting-toolbar-button ${className || ""} ${groupStart ? "formatting-group-start" : ""}`}
          title={shortcut ? `${label} (${shortcut})` : label}
          aria-label={label}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAction(action)}
        >
          {icon ? <WorkspaceIcon name={icon} size={16}/> : content}
        </button>
      ))}
    </div>
  );
}
