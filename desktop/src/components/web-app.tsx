"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserApi, http, type WebIdentity } from "../lib/browser-api";
import { WorkspaceRuntimeContext, type WorkspaceRuntime } from "../lib/workspace-runtime";
import DesktopApp from "./desktop-app";

export default function WebApp() {
  const [api, setApi] = useState<BrowserApi | null>(null);
  const apiRef = useRef<BrowserApi | null>(null);
  const [loginRequired, setLoginRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("正在连接知识库…");
  const [recoveryMessage, setRecoveryMessage] = useState("");
  async function accept(identity: WebIdentity) {
    let current = apiRef.current;
    if (current && (identity.serverId !== current.identity.serverId || identity.vaultId !== current.identity.vaultId)) throw new Error("服务端知识库标识已变化，当前编辑仍保留。请先复制未保存内容，再刷新页面连接新知识库。");
    if (!current) current = new BrowserApi(identity, () => setLoginRequired(true));
    else current.identity = identity;
    await current.resumeOperations((message) => { setStatus(message); setRecoveryMessage(message); });
    apiRef.current = current; setApi(current); setLoginRequired(false); window.dispatchEvent(new Event("noto-session-restored"));
  }
  useEffect(() => {
    let active = true;
    http<WebIdentity>("/api/session").then(async (identity) => { if (active) await accept(identity); })
      .catch((cause) => { if (active) { setLoginRequired(true); if (cause.code !== "unauthorized") setError(cause.message); } })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const runtime = useMemo<WorkspaceRuntime | null>(() => api ? {
    kind: "web", api,
    logout: async () => { await api.request<void>("/api/session", { method: "DELETE" }); setLoginRequired(true); },
  } : null, [api]);
  return <>
    {runtime && <WorkspaceRuntimeContext.Provider value={runtime}><DesktopApp /></WorkspaceRuntimeContext.Provider>}
    {runtime && recoveryMessage && <div className="web-recovery-status" role="alert"><span>{recoveryMessage}</span><button type="button" onClick={() => setRecoveryMessage("")}>关闭</button></div>}
    {(!runtime || loginRequired) && <div className="web-login-backdrop"><form className="web-login" onSubmit={async (event) => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setError("");
      try {
        const identity = await http<WebIdentity>("/api/login", { method: "POST", body: JSON.stringify({ password }) });
        setPassword(""); await accept(identity);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setBusy(false); }
    }}>
      <div className="web-login-brand">N</div><h1>Noto</h1><p>{runtime ? "重新登录后继续编辑，本机草稿会保留。" : "连接你的 Markdown 知识库"}</p>
      {error && <p className="web-login-error" role="alert">{error}</p>}
      {busy ? <p role="status">{status}</p> : <><label htmlFor="web-password">访问口令</label><input id="web-password" autoFocus type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button type="submit">登录</button></>}
      <small>个人网页工作区 · 笔记保存在服务端 · 草稿保存在当前浏览器</small>
    </form></div>}
  </>;
}
