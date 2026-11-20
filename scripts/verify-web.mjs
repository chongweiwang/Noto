import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";

const [origin, passwordFile, vault] = process.argv.slice(2);
if (!origin || !passwordFile || !vault) throw new Error("用法：node scripts/verify-web.mjs <服务地址> <测试口令文件> <隔离知识库目录>");
await stat(path.join(vault, ".noto-test-fixture"));
const password = (await readFile(passwordFile, "utf8")).trimEnd();
let cookie = "", csrf = "";
async function request(route, method = "GET", data, expected = 200) {
  const headers = { cookie, "x-noto-csrf": csrf };
  const options = { method, headers };
  if (data !== undefined) { headers["content-type"] = "application/json"; options.body = JSON.stringify(data); }
  const response = await fetch(new URL(route, origin), options);
  assert.equal(response.status, expected, `${method} ${route}: ${await (expected !== response.status ? response.clone().text() : "")}`);
  return response;
}
async function login() {
  const response = await request("/api/login", "POST", { password });
  cookie = response.headers.get("set-cookie").split(";")[0]; csrf = (await response.json()).csrf;
}
assert.equal((await fetch(new URL("/api/entries", origin))).status, 401);
await login();
const folder = `HTTP验证-${randomUUID().slice(0, 8)}`;
await request("/api/directory", "POST", { path: folder }, 204);
const notePath = `${folder}/中文 笔记.md`;
const note = await (await request("/api/note", "POST", { path: notePath, content: "# 原文\n\n[[欢迎]]\n" })).json();
await request("/api/note", "POST", { path: notePath, content: "不得覆盖" }, 409);
const uri = `/api/note?path=${encodeURIComponent(notePath)}`;
const saved = await (await request(uri, "PUT", { content: "# 更新\n\n[[欢迎]]\n", expectedVersion: note.version })).json();
await request(uri, "PUT", { content: "旧版本覆盖", expectedVersion: note.version }, 409);
assert.equal(await readFile(path.join(vault, notePath), "utf8"), saved.content);
const bytes = Buffer.from([0, 255, 1, 2, 3, 10, 128]);
const form = new FormData(); form.append("file", new Blob([bytes]), "附件 测试.bin");
const uploaded = await fetch(new URL(`/api/attachment?path=${encodeURIComponent(notePath)}`, origin), { method: "POST", headers: { cookie, "x-noto-csrf": csrf }, body: form });
assert.equal(uploaded.status, 200); const link = await uploaded.json();
const download = await request(`/api/attachment?note=${encodeURIComponent(notePath)}&link=${encodeURIComponent(link)}`);
assert.match(download.headers.get("content-disposition"), /^attachment;/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
for (const invalid of ["../outside.md", ".noto-trash/a.md", "C:/secret.md"]) await request(`/api/note?path=${encodeURIComponent(invalid)}`, "GET", undefined, 400);
const crossOrigin = await fetch(new URL("/api/note", origin), { method: "POST", headers: { cookie, "x-noto-csrf": csrf, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ path: "bad.md" }) }); assert.equal(crossOrigin.status, 403);
const operationId = randomUUID().replaceAll("-", "");
const movedPath = `${folder}/已移动.md`;
const plan = { moves: [{ from: notePath, to: movedPath }], edits: [{ path: notePath, target: movedPath, content: saved.content, expectedVersion: saved.version }], checks: [{ path: notePath, version: saved.version }] };
await request(`/api/operations/${operationId}`, "POST", plan, 202);
let operation;
for (let i = 0; i < 100; i++) {
  operation = await (await request(`/api/operations/${operationId}`)).json();
  if (!["running", "queued"].includes(operation.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.equal(operation.status, "completed", JSON.stringify(operation));
await request(`/api/operations/${operationId}`, "POST", plan, 202);
assert.equal(await readFile(path.join(vault, movedPath), "utf8"), saved.content);
await request(`/api/item?path=${encodeURIComponent(folder)}`, "DELETE", undefined, 204);
const trashed = (await (await request("/api/trash")).json()).find((item) => item.path === folder); assert.ok(trashed);
await request(`/api/trash/${trashed.id}/restore`, "POST", undefined, 204);
assert.equal(await readFile(path.join(vault, movedPath), "utf8"), saved.content);

// Compare cold and unchanged batches with 1000 small notes. Keep the fixture
// for a repeatable browser/search test rather than touching any user library.
await request("/api/directory", "POST", { path: `${folder}/批量` }, 204);
const paths = [];
for (let i = 0; i < 1000; i++) { const relative = `${folder}/批量/${String(i).padStart(4, "0")}.md`; await writeFile(path.join(vault, relative), `# 性能笔记 ${i}\n\n共享网页搜索验证。\n`); paths.push(relative); }
const started = performance.now();
const initialResponse = await request("/api/snapshot", "POST", { notes: paths.map((path) => ({ path, version: "" })) });
const initialText = await initialResponse.text(), initial = JSON.parse(initialText); const coldMs = performance.now() - started;
assert.equal(initial.notes.length, 1000);
const cachedStarted = performance.now();
const cachedText = await (await request("/api/snapshot", "POST", { notes: initial.notes.map(({ path, version }) => ({ path, version })) })).text();
const cachedMs = performance.now() - cachedStarted; assert.equal(JSON.parse(cachedText).unchanged.length, 1000);
await request("/api/session", "DELETE", undefined, 204);
await request("/api/entries", "GET", undefined, 401);
process.stdout.write(JSON.stringify({ result: "passed", origin, folder, operationId, snapshot: { notes: 1000, coldMs: Math.round(coldMs), cachedMs: Math.round(cachedMs), coldBytes: Buffer.byteLength(initialText), cachedBytes: Buffer.byteLength(cachedText) } }, null, 2) + "\n");
