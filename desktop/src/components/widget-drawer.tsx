"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { WorkspaceIcon } from "./workspace-icon";

export function WidgetDrawer({ id, title, wide, children, onClose }: {
  id: string; title: string; wide: boolean; children: ReactNode; onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      if (document.activeElement === document.body && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [title]);

  return <div className="widget-drawer-layer">
    <div className="task-drawer-backdrop" data-widget-backdrop aria-hidden="true" onClick={onClose}/>
    <section id={id} role="dialog" aria-modal="true" aria-label={title} className={"widget-drawer" + (wide ? " widget-drawer-wide" : "")} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]),select:not(:disabled),a[href],summary')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="widget-drawer-header"><h2>{title}</h2><button ref={close} type="button" className="task-detail-close" title="关闭（Esc）" aria-label={"关闭" + title} onClick={onClose}><WorkspaceIcon name="close" size={18}/></button></header>
      <div className="widget-drawer-content">{children}</div>
    </section>
  </div>;
}
