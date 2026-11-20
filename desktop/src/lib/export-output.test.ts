// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {downloadExportHtml,readyExportFrame} from "./export-output";
afterEach(()=>{document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function preview(){
 const frame=document.createElement("iframe");document.body.append(frame);
 frame.contentDocument!.head.innerHTML='<meta http-equiv="Content-Security-Policy" content="default-src none">';
 return frame;
}
it("预览等待字体和图片解码全部完成才就绪",async()=>{
 const frame=preview(),doc=frame.contentDocument!;
 let fontReady!:()=>void,imageReady!:()=>void;
 Object.defineProperty(doc,"fonts",{value:Object.assign([],{ready:new Promise<void>(resolve=>{fontReady=resolve;})})});
 const image=doc.createElement("img");doc.body.append(image);
 Object.defineProperty(image,"decode",{value:()=>new Promise<void>(resolve=>{imageReady=resolve;})});
 let ready=false;
 const work=readyExportFrame(frame,new AbortController().signal).then(()=>{ready=true;});
 fontReady();await Promise.resolve();expect(ready).toBe(false);
 imageReady();await work;expect(ready).toBe(true);
});
it("字体失败明确拒绝，取消清理回退图片监听与定时器",async()=>{
 const failed=preview();
 Object.defineProperty(failed.contentDocument!,"fonts",{value:Object.assign([{status:"error"}],{ready:Promise.resolve()})});
 await expect(readyExportFrame(failed,new AbortController().signal)).rejects.toThrow("字体无法载入");
 vi.useFakeTimers();
 const frame=preview(),image=frame.contentDocument!.createElement("img");frame.contentDocument!.body.append(image);
 Object.defineProperty(image,"complete",{value:false});
 const remove=vi.spyOn(image,"removeEventListener"),controller=new AbortController();
 const work=readyExportFrame(frame,controller.signal),rejected=expect(work).rejects.toMatchObject({name:"AbortError"});
 controller.abort();await rejected;
 expect(remove).toHaveBeenCalledWith("load",expect.any(Function));
 expect(remove).toHaveBeenCalledWith("error",expect.any(Function));
 expect(vi.getTimerCount()).toBe(0);
});
it("不支持 decode 的已失败图片立即拒绝，不再等待不会到来的 load",async()=>{
 const frame=preview(),image=frame.contentDocument!.createElement("img");frame.contentDocument!.body.append(image);
 Object.defineProperty(image,"decode",{value:undefined});
 Object.defineProperty(image,"complete",{value:true});
 await expect(readyExportFrame(frame,new AbortController().signal)).rejects.toThrow("图片无法解码");
});
it("浏览器下载失败释放 URL 后可以重试，成功只发起下载并最终释放资源",()=>{
 vi.useFakeTimers();
 const create=vi.fn(()=>"blob:test"),revoke=vi.fn();
 vi.stubGlobal("URL",class extends URL {static createObjectURL=create;static revokeObjectURL=revoke;});
 const click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementationOnce(()=>{throw new Error("下载失败");}).mockImplementation(()=>{});
 expect(()=>downloadExportHtml("<!DOCTYPE html><p>中文</p>","中文.html")).toThrow("下载失败");
 expect(revoke).toHaveBeenCalledTimes(1);
 expect(document.querySelector("a")).toBeNull();
 downloadExportHtml("<!DOCTYPE html><p>中文</p>","中文.html");
 expect(click).toHaveBeenCalledTimes(2);
 expect(create.mock.calls).toHaveLength(2);
 expect(revoke).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(60000);
 expect(revoke).toHaveBeenCalledTimes(2);
 expect(vi.getTimerCount()).toBe(0);
});
