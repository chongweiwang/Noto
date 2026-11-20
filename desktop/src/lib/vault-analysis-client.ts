"use client";

import { useEffect, useMemo } from "react";
import type { Note } from "./vault-api";
import { VaultAnalysis, type VaultAnswer, type VaultQuery, type VaultWorkerReply, type VaultWorkerRequest } from "./vault-analysis";

type Pending = {
  finish: (answer: VaultAnswer | Error) => void;
  progress?: (answer: VaultAnswer) => void;
};

const aborted = () => new DOMException("后台任务已取消", "AbortError");
const yieldToInterface = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export class VaultAnalysisClient {
  private worker?: Worker;
  private local?: VaultAnalysis;
  private sent = new Map<string, Note>();
  private pending = new Map<number, Pending>();
  private nextId = 0;

  private startWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./vault-analysis.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<VaultWorkerReply>) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.type === "progress") pending.progress?.(data.answer);
      else pending.finish(data.type === "error" ? new Error(data.error) : data.answer);
    };
    worker.onerror = () => {
      if (this.worker === worker) this.dispose(new Error("后台知识库计算中断，请重试。"));
    };
    return worker;
  }

  async run(query: VaultQuery, notes: Note[], signal: AbortSignal, progress?: (answer: VaultAnswer) => void): Promise<VaultAnswer> {
    if (signal.aborted) throw aborted();
    const current = new Map(notes.map(note => [note.path, note]));
    const removed = [...this.sent.keys()].filter(path => !current.has(path));
    const changed = notes.filter(note => {
      const prior = this.sent.get(note.path);
      return prior !== note && (prior?.version !== note.version || prior.content !== note.content);
    });
    // Both production runtimes provide Web Workers. Keep the same computation
    // usable in environments without one, including the component test runner.
    if (typeof Worker === "undefined") {
      this.local ??= new VaultAnalysis();
      this.local.update(changed, removed);
      this.sent = current;
      const result = await this.local.run(query, () => signal.aborted, progress);
      if (!result || signal.aborted) throw aborted();
      return result;
    }
    const worker = this.startWorker();
    const send = (message: VaultWorkerRequest) => worker.postMessage(message);
    if (removed.length) {
      send({ type: "notes", notes: [], removed });
      for (const path of removed) this.sent.delete(path);
    }
    for (let start = 0; start < changed.length;) {
      await yieldToInterface();
      if (signal.aborted || this.worker !== worker) throw aborted();
      let end = start, size = 0;
      while (end < changed.length && end - start < 32 && size < 256 * 1024) size += changed[end++].content.length;
      const batch = changed.slice(start, end);
      send({ type: "notes", notes: batch, removed: [] });
      for (const note of batch) this.sent.set(note.path, note);
      start = end;
    }
    if (signal.aborted || this.worker !== worker) throw aborted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (answer: VaultAnswer | Error) => {
        signal.removeEventListener("abort", cancel);
        this.pending.delete(id);
        if (answer instanceof Error) reject(answer);
        else resolve(answer);
      };
      const cancel = () => {
        if (this.worker === worker) send({ type: "cancel", id });
        finish(aborted());
      };
      this.pending.set(id, { finish, progress });
      signal.addEventListener("abort", cancel, { once: true });
      try { send({ type: "query", id, query }); }
      catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
    });
  }

  dispose(cause: Error = aborted()) {
    this.worker?.terminate();
    this.worker = undefined;
    this.local = undefined;
    this.sent.clear();
    for (const { finish } of this.pending.values()) finish(cause);
  }
}

export function useVaultAnalysis(scope?: string) {
  const client = useMemo(() => new VaultAnalysisClient(), [scope]);
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
