import {expect,it,vi} from "vitest";
import {readEmbedSaved} from "./embed-reads";

it("同库同文件合并在途读取，并限制全局并发",async()=>{
 let active=0,peak=0;
 const callbacks:(()=>void)[]=[];
 const api={read:vi.fn(async(path:string)=>{active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>callbacks.push(resolve));active--;return {path,content:path,version:"1"};})};
 const requests=["a","a","b","c","d","e"].map(path=>readEmbedSaved(api,"库",path,()=>false));
 await vi.waitFor(()=>expect(callbacks).toHaveLength(4));expect(api.read).toHaveBeenCalledTimes(4);expect(peak).toBe(4);
 callbacks.splice(0).forEach(done=>done());await vi.waitFor(()=>expect(callbacks).toHaveLength(1));callbacks.splice(0).forEach(done=>done());
 const notes=await Promise.all(requests);expect(notes.map(note=>note.path)).toEqual(["a","a","b","c","d","e"]);expect(api.read).toHaveBeenCalledTimes(5);
});

it("取消的旧库排队读取不会调用当前库接口",async()=>{
 const callbacks:(()=>void)[]=[],api={read:vi.fn(async(path:string)=>{await new Promise<void>(resolve=>callbacks.push(resolve));return {path,content:path,version:"1"};})};
 const busy=["a","b","c","d"].map(path=>readEmbedSaved(api,"旧库",path,()=>false));
 let stale=false;const old=readEmbedSaved(api,"旧库","待取消",()=>stale).catch(error=>error);stale=true;
 await vi.waitFor(()=>expect(callbacks).toHaveLength(4));callbacks.splice(0).forEach(done=>done());
 await Promise.all(busy);expect((await old).message).toContain("取消");expect(api.read).not.toHaveBeenCalledWith("待取消");
});
