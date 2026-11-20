"use client";

import { useState } from "react";
import type { StorageCheckStatus, StorageDiagnostics, StorageDirectory } from "../lib/vault-api";
import { useWorkspaceRuntime } from "../lib/workspace-runtime";

const failureLabels: Record<Exclude<StorageCheckStatus, "ok">, string> = {
  missing: "目录不存在",
  notDirectory: "该路径不是目录",
  permissionDenied: "权限不足",
  readOnly: "文件系统只读",
  storageFull: "空间或配额不足",
  cleanupFailed: "临时文件清理失败",
  failed: "检查失败",
};

function CheckResult({ status, success }: { status: StorageCheckStatus; success: string }) {
  return <dd data-status={status}>{status === "ok" ? success : failureLabels[status]}</dd>;
}

function DirectoryResult({ title, directory }: { title: string; directory: StorageDirectory | null }) {
  return <section className="storage-directory" aria-label={title}>
    <h4>{title}</h4>
    {directory ? <>
      <code className="storage-path">{directory.path}</code>
      <dl>
        <div><dt>读取目录</dt><CheckResult status={directory.read} success="可读"/></div>
        <div><dt>写入目录</dt><CheckResult status={directory.write} success="可写"/></div>
      </dl>
    </> : <p>尚未打开知识库</p>}
  </section>;
}

export function StorageDiagnosticsPanel() {
  const { kind, api } = useWorkspaceRuntime();
  const [report, setReport] = useState<StorageDiagnostics | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    if (running || !api.storageDiagnostics) return;
    setRunning(true);
    setReport(null);
    setError("");
    try { setReport(await api.storageDiagnostics()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRunning(false); }
  }

  return <>
    <h3>存储与诊断</h3>
    <div className="storage-check-actions">
      <p className="settings-hint">检查会在目录里写入并清理临时文件。结果反映目录本身的读写权限。</p>
      <button type="button" disabled={running || !api.storageDiagnostics} onClick={() => { void check(); }}>{running ? "检查中…" : "检查读写权限"}</button>
    </div>
    {!api.storageDiagnostics && <p className="settings-hint">当前版本无法运行存储检查。</p>}
    {error && <p role="alert" className="storage-check-error">无法完成存储检查。{error}</p>}
    {report && <div className="storage-results" aria-live="polite">
      <DirectoryResult title="知识库目录" directory={report.vault}/>
      <DirectoryResult title={kind === "web" ? "服务数据目录" : "应用数据目录"} directory={report.data}/>
      {kind === "web" && <p className="settings-hint">这里显示服务端路径。使用 Docker 时，请在容器的文件夹映射中查找对应的 NAS 路径。</p>}
    </div>}
  </>;
}
