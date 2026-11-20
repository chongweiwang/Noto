// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {CanvasResources} from "./canvas-resources";
import {base64Text} from "./export-resources";
import {emptyDrawing,serializeDrawing} from "./drawing-document";
afterEach(()=>vi.restoreAllMocks());
it("画布白板预览只读保存态，刷新读取新版本，损坏文件可重试",async()=>{
 const first=serializeDrawing(emptyDrawing()),read=vi.fn().mockResolvedValueOnce({path:"a.drawing",content:first,version:"1"}).mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce({path:"a.drawing",content:first,version:"2"});
 const pool=new CanvasResources({read,image:vi.fn()},"画布.canvas"),result=await pool.load("a.drawing");
 expect(result.version).toBe("1");expect(result.image).toMatch(/^data:image\/svg\+xml;base64,/);expect(read).toHaveBeenCalledTimes(1);
 pool.invalidate();await expect(pool.load("a.drawing")).rejects.toThrow("读取失败");expect((await pool.load("a.drawing")).version).toBe("2");pool.dispose();
});
it("预览路径去重且最多四项并发，不因坐标变化重新读取",async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let running=0,peak=0;
 const read=vi.fn(async(path:string)=>{running++;peak=Math.max(peak,running);await gate;running--;return {path,content:"已保存摘要",version:"v1"};});
 const pool=new CanvasResources({read,image:vi.fn()},"画布/a.canvas");
 const first=pool.load("a0.md");expect(pool.load("a0.md")).toBe(first);
 const jobs=[first,...Array.from({length:9},(_,i)=>pool.load("a"+(i+1)+".md"))];
 expect(read).toHaveBeenCalledTimes(4);release();await Promise.all(jobs);
 expect(peak).toBe(4);expect(read).toHaveBeenCalledTimes(10);
 await pool.load("a0.md");expect(read).toHaveBeenCalledTimes(10);pool.dispose();
});
it("笔记预览保留完整公式并在未读完的代码块前截断", async () => {
 const markdown = `# 标题\n\n${"段落".repeat(400)}\n\n$$\\frac{1}{2}$$`;
 const content = `${markdown}\n\n\`\`\`txt\n${"x".repeat(17000)}\n\`\`\``;
 const read = vi.fn(async (path: string) => ({ path, content, version: "v1" }));
 const pool = new CanvasResources({ read, image: vi.fn() }, "画布.canvas");

 const preview = await pool.load("公式.md");

 expect(preview.previewMarkdown).toBe(markdown);
 expect(preview.text).toBe(content.slice(0, 600));
 pool.dispose();
});
it("图片把根相对字段显式换算为相对画布参数，保留百分号和井号",async()=>{
 const image=vi.fn(async()=>"data:image/png;base64,AQID");
 const pool=new CanvasResources({read:vi.fn(),image},"画布/子/a.canvas");
 await pool.load("附件/100%20 #.png");
 expect(image).toHaveBeenCalledWith("画布/子/a.canvas","../../附件/100%20 #.png");pool.dispose();
});
it("失败不缓存成成功；刷新/关闭隔离队列，SVG 外部内容拒绝",async()=>{
 const read=vi.fn().mockRejectedValueOnce(new Error("暂时失败")).mockResolvedValue({path:"a.md",content:"恢复",version:"v1"});
 const image=vi.fn(async()=>"data:image/svg+xml;base64,"+base64Text('<svg><image href="https://external/x"/></svg>'));
 const pool=new CanvasResources({read,image},"a.canvas");
 await expect(pool.load("a.md")).rejects.toThrow("失败");
 expect((await pool.load("a.md")).text).toBe("恢复");
 pool.invalidate();await pool.load("a.md");expect(read).toHaveBeenCalledTimes(3);
 await expect(pool.load("a.svg")).rejects.toThrow("外部");pool.dispose();
 await expect(pool.load("b.md")).rejects.toThrow("已关闭");
});
