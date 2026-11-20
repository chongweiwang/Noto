"use client";

import { useEffect, useRef, useState } from "react";
import { WorkspaceIcon } from "./workspace-icon";

export function VaultSwitcher({ vault, web, busy, onOpen, onCreate }: {
  vault: string | null; web: boolean; busy: boolean; onOpen: () => void; onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const name = vault?.replace(/^\\\\\?\\/, "").split(/[\\/]/).filter(Boolean).pop() || "打开知识库";
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => { if (busy || web) setOpen(false); }, [busy, web]);
  return <div className="vault-selector" ref={container} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={(event) => {
    if (open && event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="vault-switch" disabled={busy || web} onClick={() => setOpen((value) => !value)}
      title={web ? "服务端挂载的知识库" : vault || "打开知识库"} aria-label={`知识库选项：${name}`} aria-expanded={web ? undefined : open} aria-controls={open ? "vault-actions" : undefined}>
      <span>{name}</span>{!web && <WorkspaceIcon name="chevron" className="vault-chevron" size={12} />}
    </button>
    {open && <div id="vault-actions" className="vault-actions" role="group" aria-label="知识库操作">
      <div className="vault-actions-label">知识库</div>
      <button type="button" onClick={() => { setOpen(false); onOpen(); }}><WorkspaceIcon name="folder-open" size={16} />打开其他知识库</button>
      <button type="button" onClick={() => { setOpen(false); onCreate(); }}><WorkspaceIcon name="new-folder" size={16} />新建知识库</button>
    </div>}
  </div>;
}
