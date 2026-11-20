import { VaultAnalysis, type VaultWorkerReply, type VaultWorkerRequest } from "./vault-analysis";

const analysis = new VaultAnalysis();
const running = new Map<number, AbortController>();
const reply = (message: VaultWorkerReply) => self.postMessage(message);

self.onmessage = ({ data }: MessageEvent<VaultWorkerRequest>) => {
  if (data.type === "notes") {
    analysis.update(data.notes, data.removed);
    return;
  }
  if (data.type === "cancel") {
    running.get(data.id)?.abort();
    return;
  }
  const job = new AbortController();
  running.set(data.id, job);
  void analysis.run(data.query, () => job.signal.aborted, answer => {
    if (!job.signal.aborted) reply({ type: "progress", id: data.id, answer });
  }).then(answer => {
    if (answer && !job.signal.aborted) reply({ type: "result", id: data.id, answer });
  }).catch(cause => {
    if (!job.signal.aborted) reply({ type: "error", id: data.id, error: cause instanceof Error ? cause.message : String(cause) });
  }).finally(() => running.delete(data.id));
};
