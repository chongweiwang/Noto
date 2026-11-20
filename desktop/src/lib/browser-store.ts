import type { Draft } from "./vault-api";

// A transaction must complete before callers are allowed to remove an old
// draft. Request success alone does not mean IndexedDB committed the write.
export class BrowserStore {
  private connection?: Promise<IDBDatabase>;
  constructor(readonly scope: string) {}
  private db() {
    return this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("noto-local-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: ["scope", "key"] });
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.connection = undefined; }; resolve(request.result); };
      request.onerror = () => { this.connection = undefined; reject(request.error ?? new Error("无法打开本机草稿库")); };
      request.onblocked = () => { this.connection = undefined; reject(new Error("本机草稿库正在升级，请关闭其他 Noto 页面后重试")); };
    });
  }
  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("records", "readonly");
      const request = transaction.objectStore("records").get([this.scope, key]);
      transaction.oncomplete = () => resolve(request.result?.value);
      transaction.onabort = () => reject(transaction.error ?? new Error("无法读取本机草稿"));
    });
  }
  async records<T>(prefix: string): Promise<{ key: string; value: T }[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("records", "readonly");
      const request = transaction.objectStore("records").getAll(IDBKeyRange.bound([this.scope, prefix], [this.scope, prefix + "\uffff"]));
      transaction.oncomplete = () => resolve(request.result.map(({ key, value }) => ({ key, value })));
      transaction.onabort = () => reject(transaction.error ?? new Error("无法读取本机草稿"));
    });
  }
  async put(key: string, value: unknown): Promise<void> { await this.mutate([{ key, value }], []); }
  async remove(key: string): Promise<void> { await this.mutate([], [key]); }
  async mutate(writes: { key: string; value: unknown }[], removes: string[]): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("本机草稿保存失败，请检查浏览器存储权限和可用空间"));
      try {
        for (const { key, value } of writes) store.put({ scope: this.scope, key, value });
        for (const key of removes) store.delete([this.scope, key]);
      } catch (error) { transaction.abort(); reject(error); }
    });
  }
  async drafts(): Promise<Draft[]> { return (await this.records<Draft>("draft:")).map(({ value }) => value).sort((a, b) => a.path.localeCompare(b.path)); }
  async writeDraft(draft: Draft) { await this.put(`draft:${draft.path}`, draft); }
  async removeDraft(path: string) { await this.remove(`draft:${path}`); }
  async migrateDrafts(updates: { oldKey: string; original: Draft; key: string; draft: Draft }[], writes: { key: string; value: unknown }[], removes: string[]) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite"), store = transaction.objectStore("records");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("草稿路径更新失败，旧草稿仍保留"));
      try {
        for (const update of updates) {
          const request = store.get([this.scope, update.oldKey]);
          request.onsuccess = () => {
            // A second browser tab may have continued typing since the plan was
            // created. Retain that newer branch instead of overwriting it.
            const current = request.result?.value as Draft | undefined;
            if (current?.content === update.original.content && current.baseVersion === update.original.baseVersion) store.delete([this.scope, update.oldKey]);
            store.put({ scope: this.scope, key: update.key, value: update.draft });
          };
        }
        for (const { key, value } of writes) store.put({ scope: this.scope, key, value });
        for (const key of removes) store.delete([this.scope, key]);
      } catch (error) { transaction.abort(); reject(error); }
    });
  }
  async removeIfUnchanged(key: string, expected: Draft) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite"), store = transaction.objectStore("records");
      const request = store.get([this.scope, key]);
      request.onsuccess = () => { const current = request.result?.value as Draft | undefined; if (current?.content === expected.content && current.baseVersion === expected.baseVersion) store.delete([this.scope, key]); };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error("草稿清理失败"));
    });
  }
  async rebaseDraft(key: string, baseVersion: string, version: string, journalKey: string, snapshot: { content: string; baseVersion: string }): Promise<boolean> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      let matched = false;
      const transaction = db.transaction("records", "readwrite"), store = transaction.objectStore("records");
      const journal = store.get([this.scope, journalKey]);
      journal.onsuccess = () => {
        const pending = journal.result?.value;
        if (pending?.content !== snapshot.content || pending.baseVersion !== snapshot.baseVersion) return;
        matched = true;
        const request = store.get([this.scope, key]);
        request.onsuccess = () => {
          const draft = request.result?.value as Draft | undefined;
          if (draft?.baseVersion === baseVersion) store.put({ scope: this.scope, key, value: { ...draft, baseVersion: version } });
          store.delete([this.scope, journalKey]);
        };
      };
      transaction.oncomplete = () => resolve(matched); transaction.onabort = () => reject(transaction.error ?? new Error("无法更新草稿版本"));
    });
  }
}
