// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {base64Text,bounded,decodeExportImage,safeExportImage} from "./export-resources";
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

it("中止或超时立即清理定时器和监听，不等待原始资源结束",async()=>{
 vi.useFakeTimers();
 const controller=new AbortController(),remove=vi.spyOn(controller.signal,"removeEventListener");
 let deliver!:(value:string)=>void;
 const source=new Promise<string>(resolve=>{deliver=resolve;});
 const result=bounded(source,controller.signal),rejected=expect(result).rejects.toMatchObject({name:"AbortError"});
 expect(vi.getTimerCount()).toBe(1);
 controller.abort();await rejected;
 expect(vi.getTimerCount()).toBe(0);
 expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));
 deliver("迟到资源");await source;
 const timed=bounded(new Promise(()=>{}),undefined,10),timeout=expect(timed).rejects.toThrow("超时");
 await vi.advanceTimersByTimeAsync(10);await timeout;
 expect(vi.getTimerCount()).toBe(0);
});
it.each([undefined,null,""])("资源拒绝即使没有错误文本也不能被当作成功：%s",async(reason)=>{
 await expect(bounded(Promise.reject(reason))).rejects.toBe(reason);
});
it("图片解码失败后清除来源与回调，下一次解码可重试",async()=>{
 const images:HTMLImageElement[]=[];
 vi.stubGlobal("Image",class {
  onload=null;onerror=null;src="";
  constructor(){images.push(this as unknown as HTMLImageElement);}
  decode(){return images.length===1?Promise.reject(new Error("坏图")):Promise.resolve();}
  removeAttribute(){this.src="";}
 });
 await expect(decodeExportImage("data:image/png;base64,AQID")).rejects.toThrow("坏图");
 await decodeExportImage("data:image/png;base64,AQID");
 expect(images).toHaveLength(2);
 for(const image of images){expect(image.src).toBe("");expect(image.onload).toBeNull();expect(image.onerror).toBeNull();}
});
it("SVG 允许本图带引号的片段引用，拒绝远程样式",()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect style="fill:url(\'#g\')"/></svg>';
 expect(safeExportImage("data:image/svg+xml;base64,"+base64Text(svg))).toContain("data:image/svg+xml;base64,");
 expect(()=>safeExportImage("data:image/svg+xml;base64,"+base64Text(svg.replace("#g","https://example.org/g")))).toThrow("外部");
});
