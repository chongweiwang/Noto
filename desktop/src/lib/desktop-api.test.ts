import {beforeEach,expect,it,vi} from "vitest";
const native=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>native);
vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn()}));
import {desktop} from "./desktop-api";
beforeEach(()=>native.invoke.mockReset());
it("WebDAV 通过原生接口传递连接和受保护路径，不使用本地草稿之外的覆盖接口",async()=>{
  const config={url:"https://dav.test/",username:"user",password:"pass",remotePath:"Noto"};const input={config,protectedPaths:["a.md"],resolutions:[]};native.invoke.mockResolvedValue(undefined);
  await desktop.webdavTest(config);expect(native.invoke).toHaveBeenLastCalledWith("webdav_test",{config});await desktop.webdavSync(input);expect(native.invoke).toHaveBeenLastCalledWith("webdav_sync",{input});
});
it("文件恢复 IPC 参数包含路径、快照标识和预期磁盘版本",async()=>{
  native.invoke.mockResolvedValue([]);await desktop.fileHistory!("中文/a.md");expect(native.invoke).toHaveBeenLastCalledWith("file_history",{path:"中文/a.md"});
  await desktop.readHistory!("中文/a.md","snapshot");expect(native.invoke).toHaveBeenLastCalledWith("read_history",{path:"中文/a.md",id:"snapshot"});
  await desktop.checkpointHistory!("中文/a.md","未保存内容","v2");expect(native.invoke).toHaveBeenLastCalledWith("checkpoint_history",{path:"中文/a.md",content:"未保存内容",expectedVersion:"v2"});
});
it.each(["系统找不到指定的文件。 (os error 2)","系统找不到指定的路径。 (os error 3)","No such file or directory (os error 2)","文件不存在"])("将原生文件缺失归类为 not_found：%s",async(message)=>{
  native.invoke.mockRejectedValueOnce(message);
  await expect(desktop.read("旧文件.drawing")).rejects.toMatchObject({code:"not_found"});
});
it("拒绝访问仍为 permission，不能在丢弃草稿时冒充原文件不存在",async()=>{
  native.invoke.mockRejectedValueOnce("拒绝访问。 (os error 5)");
  await expect(desktop.read("笔记.md")).rejects.toMatchObject({code:"permission"});
});
