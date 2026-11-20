import {parseCanvas,serializeCanvas,createCanvasNode} from "./canvas-document";
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApi, type WebIdentity } from "./browser-api";
import { BrowserStore } from "./browser-store";
import { WorkspaceError } from "./api-error";
import type { Note } from "./vault-api";

const identity: WebIdentity = { serverId: "server-a", vaultId: "vault-a", vault: "测试知识库", csrf: "csrf" };
let store: BrowserStore, api: BrowserApi, auth: ReturnType<typeof vi.fn<() => void>>;
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
beforeEach(() => { store = new BrowserStore(`test-${crypto.randomUUID()}`); auth = vi.fn(); api = new BrowserApi(identity, auth, store); });
afterEach(() => vi.unstubAllGlobals());
it("WebDAV 请求带认证/CSRF且不把密码写到本机恢复存储",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(response({uploaded:0,downloaded:0,conflicts:[],errors:[],skipped:[],changed:[],deletedLocal:0,deletedRemote:0}));vi.stubGlobal("fetch",fetch);
  const config={url:"https://dav.test/",username:"user",password:"secret",remotePath:"Noto"};await api.webdavTest(config);await api.webdavSync({config,protectedPaths:["a.md"],resolutions:[]});
  expect(fetch.mock.calls[0][0]).toBe("/api/webdav/test");expect(fetch.mock.calls[1][0]).toBe("/api/webdav/sync");expect(new Headers(fetch.mock.calls[1][1].headers).get("x-noto-csrf")).toBe("csrf");expect(await store.records("")).toEqual([]);
});
it("文件恢复通过编码后的路径读取，保护快照带 CSRF 与预期版本且不直接还原文件",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({content:"旧内容"})).mockResolvedValueOnce(new Response(null,{status:204}));vi.stubGlobal("fetch",fetch);
  await api.fileHistory!("中文/a #.md");expect(fetch.mock.calls[0][0]).toBe("/api/history?path="+encodeURIComponent("中文/a #.md"));
  await api.readHistory!("中文/a #.md","id+a");expect(fetch.mock.calls[1][0]).toContain("&id=id%2Ba");
  await api.checkpointHistory!("中文/a #.md","未保存","v2");
  const [url,options]=fetch.mock.calls[2];expect(url).toBe("/api/history/checkpoint");expect(options.method).toBe("POST");expect(new Headers(options.headers).get("x-noto-csrf")).toBe("csrf");expect(JSON.parse(options.body)).toEqual({path:"中文/a #.md",content:"未保存",expectedVersion:"v2"});
});

describe("网页本机草稿与恢复", () => {
  it("按实例、知识库与用户隔离，确认事务提交后才能移除旧路径", async () => {
    await store.writeDraft({ path: "中文/笔记.md", content: "未保存内容", baseVersion: "v1" });
    const another = new BrowserStore(store.scope + "-other"); expect(await another.drafts()).toEqual([]);
    await store.mutate([{ key: "draft:新位置.md", value: { path: "新位置.md", content: "未保存内容", baseVersion: "v1" } }], ["draft:中文/笔记.md"]);
    expect(await new BrowserStore(store.scope).drafts()).toEqual([{ path: "新位置.md", content: "未保存内容", baseVersion: "v1" }]);
  });
  it("一次事务中的后续写入失败会撤销前面的写入", async () => {
    await store.put("original", "keep");
    await expect(store.mutate([{ key: "new", value: "must roll back" }, { key: "bad", value: () => {} }], ["original"])).rejects.toThrow();
    expect(await store.get("new")).toBeUndefined(); expect(await store.get("original")).toBe("keep");
  });
  it("请求失败时仍可本机保存，认证失效有独立错误且不删除草稿", async () => {
    await api.writeDraft({ path: "a.md", content: "离线输入", baseVersion: "v1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code: "unauthorized", message: "登录失效" }, 401)));
    await expect(api.save("a.md", "离线输入", "v1")).rejects.toMatchObject({ code: "unauthorized" });
    expect(auth).toHaveBeenCalled(); expect((await store.drafts())[0].content).toBe("离线输入");
    expect((await store.records("write:"))[0].value).toMatchObject({ content: "离线输入", baseVersion: "v1" });
  });
  it("保存成功但响应丢失时，通过读取相同快照确认版本", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValueOnce(response({ path: "a.md", content: "快照", version: "v2" })));
    const result = await api.save("a.md", "快照", "v1");
    expect(result.version).toBe("v2"); expect(await store.records("write:")).toEqual([]);
  });
  it("断线后刷新：确认旧快照已保存，更新后续编辑草稿的基准", async () => {
    await store.writeDraft({ path: "a.md", content: "快照之后继续输入", baseVersion: "v1" });
    await store.put("write:a.md", { content: "快照", baseVersion: "v1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ path: "a.md", content: "快照", version: "v2" })));
    expect(await api.drafts()).toEqual([expect.objectContaining({ path: "a.md", content: "快照之后继续输入", baseVersion: "v2" })]);
    expect(await store.get("write:a.md")).toBeUndefined();
  });
  it("真实外部修改不能当作成功的旧快照，保留本机草稿", async () => {
    await store.writeDraft({ path: "a.md", content: "本机", baseVersion: "v1" });
    await store.put("write:a.md", { content: "旧快照", baseVersion: "v1" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, options) => options.method === "PUT" ? response({ code: "conflict", message: "外部修改" }, 409) : response({ path: "a.md", content: "外部修改", version: "v3" })));
    expect((await api.drafts())[0].baseVersion).toBe("v1");
    await expect(api.save("a.md", "本机", "v1")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.drafts())[0].content).toBe("本机");
  });
  it("网页保存回传 Rust 的版本，发送 CSRF 校验且不调用本地加密摘要", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ path: "a.md", content: "内容", version: "sha256-server" })); vi.stubGlobal("fetch", fetchMock);
    await api.save("a.md", "内容", "sha256-previous");
    const options = fetchMock.mock.calls[0][1];
    expect(options.credentials).toBe("same-origin"); expect(options.headers.get("x-noto-csrf")).toBe("csrf");
    expect(JSON.parse(options.body)).toEqual({ content: "内容", expectedVersion: "sha256-previous" });
  });
});

describe("网页目录操作恢复", () => {
  const original: Note = { path: "a.md", content: "[附件](attachments/a.pdf)", version: "v1" };
  const moved: Note = { path: "folder/b.md", content: "[附件](../attachments/a.pdf)", version: "v2" };
  const plan = { moves: [{ from: "a.md", to: "folder/b.md" }], edits: [{ path: "a.md", target: "folder/b.md", content: moved.content, expectedVersion: "v1" }], checks: [{ path: "a.md", version: "v1" }] };
  it("提交响应丢失后按持久化标识查询，原子迁移草稿，不重复执行移动", async () => {
    await store.writeDraft({ path: "a.md", content: original.content + "\n新输入", baseVersion: "v1" });
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("lost")); vi.stubGlobal("fetch", fetchMock);
    await expect(api.relocate(plan, [original])).rejects.toMatchObject({ code: "network" });
    const pending = (await store.records<{ id: string }>("operation:"))[0].value;
    fetchMock.mockResolvedValue(response({ id: pending.id, status: "completed", completedMoves: plan.moves, notes: [moved], backup: `backups/${pending.id}`, message: null }));
    await new BrowserApi(identity, auth, store).resumeOperations(vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    expect(await store.drafts()).toEqual([expect.objectContaining({ path: "folder/b.md", content: moved.content + "\n新输入", baseVersion: "v2" })]);
    expect(await store.records("operation:")).toEqual([]);
  });
  it("只有查询明确不存在时，以相同操作标识补交；部分成功要求显式恢复", async () => {
    const pending = { id: "12345678123456781234567812345678", plan, originals: [original], drafts: [{ path: "a.md", content: "本机草稿", baseVersion: "v1" }] };
    await store.put(`operation:${pending.id}`, pending);
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ code: "not_found", message: "不存在" }, 404)).mockResolvedValueOnce(response({ status: "queued" })).mockResolvedValueOnce(response({ id: pending.id, status: "failed", completedMoves: plan.moves, notes: [], backup: `backups/${pending.id}`, message: "中断" })); vi.stubGlobal("fetch", fetchMock);
    await api.resumeOperations(vi.fn());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(3).fill(`/api/operations/${pending.id}`));
    expect((await store.drafts())[0]).toMatchObject({ path: "folder/b.md", content: "本机草稿", baseVersion: "incomplete:v1" });
  });
  it("查询失败保留操作和旧草稿，禁止发起第二次目录调整", async () => {
    await store.put("operation:pending", { id: "pending" }); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(api.resumeOperations(vi.fn())).rejects.toBeInstanceOf(WorkspaceError);
    await expect(api.relocate(plan, [original])).rejects.toMatchObject({ code: "operation_pending" });
    expect(await store.records("operation:")).toHaveLength(1);
  });
});

describe("多个网页标签的草稿分支", () => {
  it("两个页面编辑同一文件分别持久化，成功保存仅清理本页面分支", async () => {
    const other = new BrowserApi(identity, auth, store);
    await api.writeDraft({ path: "a.md", content: "页面 A", baseVersion: "v1" });
    await other.writeDraft({ path: "a.md", content: "页面 B", baseVersion: "v1" });
    expect((await store.drafts()).map((draft) => draft.content).sort()).toEqual(["页面 A", "页面 B"]);
    await api.removeDraft("a.md");
    expect((await store.drafts()).map((draft) => draft.content)).toEqual(["页面 B"]);
  });
  it("恢复旧草稿后，其他页面新增的输入不会被后续清理删除", async () => {
    const other = new BrowserApi(identity, auth, store);
    await other.writeDraft({ path: "a.md", content: "页面 B 旧内容", baseVersion: "v1" });
    api.selectDraft((await api.drafts())[0]);
    await api.writeDraft({ path: "a.md", content: "恢复后 A 继续输入", baseVersion: "v1" });
    await other.writeDraft({ path: "a.md", content: "页面 B 新内容", baseVersion: "v1" });
    await api.removeDraft("a.md");
    expect((await store.drafts()).map((draft) => draft.content)).toEqual(["页面 B 新内容"]);
  });
});

describe("网页画布沿用原恢复与迁移协议",()=>{
 it("画布保存响应丢失仍只确认提交快照，后续 JSON 草稿保留",async()=>{
  const old=serializeCanvas({nodes:[createCanvasNode("text",{x:0,y:0},{text:"旧快照"})],edges:[]}),latest=old.replace("旧快照","后续本地输入");
  await api.writeDraft({path:"a.canvas",content:latest,baseVersion:"v1"});
  const fetchMock=vi.fn().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(response({path:"a.canvas",content:old,version:"v2"}));vi.stubGlobal("fetch",fetchMock);
  expect((await api.save("a.canvas",old,"v1")).version).toBe("v2");
  expect((await store.drafts())[0].content).toBe(latest);expect(await store.records("write:")).toEqual([]);
 });
 it("服务端已移动但响应丢失，重开后原子恢复画布文件字段、卡片 Markdown 和草稿路径",async()=>{
  const content=serializeCanvas({nodes:[createCanvasNode("file",{x:0,y:0},{file:"笔记/a.md"}),createCanvasNode("text",{x:300,y:0},{text:"[目标](笔记/a.md)"})],edges:[]});
  const original={path:"a.canvas",content,version:"v1"},moves=[{from:"a.canvas",to:"folder/a.canvas"},{from:"笔记/a.md",to:"笔记/b.md"}];
  await store.writeDraft({path:original.path,content,baseVersion:"v1"});
  vi.stubGlobal("fetch",vi.fn().mockRejectedValueOnce(new TypeError("lost")));
  await expect(api.relocate({moves,edits:[],checks:[]},[original])).rejects.toMatchObject({code:"network"});
  const pending=(await store.records<{id:string}>("operation:"))[0].value;
  const next=parseCanvas(content);next.nodes[0].file="笔记/b.md";next.nodes[1].text="[目标](../%E7%AC%94%E8%AE%B0/b.md)";
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({id:pending.id,status:"completed",completedMoves:moves,notes:[{path:"folder/a.canvas",content:serializeCanvas(next),version:"v2"}],backup:"backups/"+pending.id,message:null})));
  await new BrowserApi(identity,auth,store).resumeOperations(vi.fn());
  const draft=(await store.drafts())[0];expect(draft.path).toBe("folder/a.canvas");expect(draft.baseVersion).toBe("v2");
  const parsed=parseCanvas(draft.content);expect(parsed.nodes[0].file).toBe("笔记/b.md");expect(parsed.nodes[1].text).toContain("../%E7%AC%94%E8%AE%B0/b.md");
  expect(await store.records("operation:")).toEqual([]);
 });
 it("认证失败和多页面画布草稿分别保留，成功清理不删除其他分支",async()=>{
  const content='{"nodes":[],"edges":[]}',other=new BrowserApi(identity,auth,store);
  await api.writeDraft({path:"a.canvas",content,baseVersion:"v1"});await other.writeDraft({path:"a.canvas",content:content.replace("[]",'[ ]'),baseVersion:"v1"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({code:"unauthorized",message:"登录过期"},401)));
  await expect(api.save("a.canvas",content,"v1")).rejects.toMatchObject({code:"unauthorized"});
  expect(await store.drafts()).toHaveLength(2);await api.removeDraft("a.canvas");expect(await store.drafts()).toHaveLength(1);
 });
});

describe("网页白板沿用保存确认、认证与迁移分支",()=>{
 const drawing=(file="笔记/a.md")=>JSON.stringify({type:"noto-drawing",version:1,background:"#ffffff",extra:{keep:1},elements:[{id:"t",type:"text",x:0,y:0,width:100,height:40,strokeColor:"#123456",fontSize:20,text:"旧文字",link:{file,subpath:"#标题"}}]});
 it("白板响应丢失只确认提交快照，最新JSON草稿保留",async()=>{
  const old=drawing(),latest=old.replace("旧文字","后续编辑");await api.writeDraft({path:"a.drawing",content:latest,baseVersion:"v1"});
  vi.stubGlobal("fetch",vi.fn().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(response({path:"a.drawing",content:old,version:"v2"})));
  expect((await api.save("a.drawing",old,"v1")).version).toBe("v2");expect((await store.drafts())[0].content).toBe(latest);expect(await store.records("write:")).toEqual([]);
 });
 it("白板迁移响应丢失后按实际路径和关联恢复JSON草稿",async()=>{
  const content=drawing(),original={path:"a.drawing",content,version:"v1"},moves=[{from:"a.drawing",to:"folder/a.drawing"},{from:"笔记/a.md",to:"笔记/b.md"}];
  await store.writeDraft({path:original.path,content,baseVersion:"v1"});vi.stubGlobal("fetch",vi.fn().mockRejectedValueOnce(new TypeError("lost")));
  await expect(api.relocate({moves,edits:[],checks:[]},[original])).rejects.toMatchObject({code:"network"});
  const pending=(await store.records<{id:string}>("operation:"))[0].value;
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({id:pending.id,status:"completed",completedMoves:moves,notes:[{path:"folder/a.drawing",content:drawing("笔记/b.md"),version:"v2"}],backup:"backups/"+pending.id,message:null})));
  await new BrowserApi(identity,auth,store).resumeOperations(vi.fn());const draft=(await store.drafts())[0];
  expect(draft.path).toBe("folder/a.drawing");expect(draft.baseVersion).toBe("v2");expect(JSON.parse(draft.content).elements[0].link).toEqual({file:"笔记/b.md",subpath:"#标题"});expect(JSON.parse(draft.content).extra).toEqual({keep:1});expect(await store.records("operation:")).toEqual([]);
 });
 it("部分完成只映射已移动路径，未完成目标关联不猜测",async()=>{
  const content=drawing(),original={path:"a.drawing",content,version:"v1"},moves=[{from:"a.drawing",to:"folder/a.drawing"},{from:"笔记/a.md",to:"笔记/b.md"}];
  await store.writeDraft({path:original.path,content,baseVersion:"v1"});vi.stubGlobal("fetch",vi.fn().mockRejectedValueOnce(new TypeError("lost")));
  await expect(api.relocate({moves,edits:[],checks:[]},[original])).rejects.toMatchObject({code:"network"});
  const pending=(await store.records<{id:string}>("operation:"))[0].value;
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({id:pending.id,status:"failed",completedMoves:[moves[0]],notes:[],backup:"backups/"+pending.id,message:"second move failed"})));
  const next=new BrowserApi(identity,auth,store),handler=vi.fn();next.onRelocationRecovered(handler);await next.resumeOperations(vi.fn());
  const draft=(await store.drafts())[0];expect(draft.path).toBe("folder/a.drawing");expect(JSON.parse(draft.content).elements[0].link.file).toBe("笔记/a.md");expect(draft.baseVersion).toBe("incomplete:v1");expect(handler).toHaveBeenCalledWith(expect.anything(),true);
 });
 it("认证失败、多页白板分支和清理相互隔离",async()=>{
  const content=drawing(),other=new BrowserApi(identity,auth,store);await api.writeDraft({path:"a.drawing",content,baseVersion:"v1"});await other.writeDraft({path:"a.drawing",content:content.replace("旧文字","其他页面"),baseVersion:"v1"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({code:"unauthorized",message:"登录过期"},401)));
  await expect(api.save("a.drawing",content,"v1")).rejects.toMatchObject({code:"unauthorized"});expect(await store.drafts()).toHaveLength(2);
  await api.removeDraft("a.drawing");expect((await store.drafts())[0].content).toContain("其他页面");
 });
});
