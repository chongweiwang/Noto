import { bounded, checkCancelled, maxExportBytes } from "./export-resources";
export async function readyExportFrame(frame:HTMLIFrameElement, signal:AbortSignal) {
  const doc=frame.contentDocument;
  if(!doc?.body || !doc.querySelector('meta[http-equiv="Content-Security-Policy"]')) throw new Error("导出预览尚未载入");
  checkCancelled(signal);
  void doc.body.offsetHeight;
  const cleanup:(()=>void)[]=[];
  try {
    await bounded(Promise.all([
      doc.fonts?.ready??Promise.resolve(),
      ...[...doc.images].map((img)=> typeof img.decode==="function"?img.decode():img.complete?(img.naturalWidth?Promise.resolve():Promise.reject(new Error("预览图片无法解码"))):new Promise<void>((resolve,reject)=>{
        const load=()=>resolve(),error=()=>reject(new Error("预览图片无法解码"));
        img.addEventListener("load",load,{once:true}); img.addEventListener("error",error,{once:true});
        cleanup.push(()=>{img.removeEventListener("load",load);img.removeEventListener("error",error);});
      })),
    ]),signal);
    checkCancelled(signal);
    if(doc.fonts && [...doc.fonts].some((font)=>font.status==="error")) throw new Error("导出字体无法载入");
  } finally {cleanup.forEach(release=>release());}
}
export function downloadExportHtml(html:string,name:string) {
  const blob=new Blob([html],{type:"text/html;charset=utf-8"});
  if(blob.size>maxExportBytes) throw new Error("导出内容超过大小上限（64 MiB）");
  downloadBlob(blob,name);
}
export function downloadBlob(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob), link=document.createElement("a");
  let timer:ReturnType<typeof setTimeout>;
  const release=()=>{clearTimeout(timer); URL.revokeObjectURL(url); window.removeEventListener("pagehide",release);};
  try { link.href=url; link.download=name; document.body.appendChild(link); link.click(); }
  catch(error) { release(); throw error; }
  finally { link.remove(); }
  // Browser download completion is not observable. Keep the URL alive while it
  // is consumed; release on page exit or after a bounded lifetime.
  window.addEventListener("pagehide",release,{once:true});
  timer=setTimeout(release,60000);
}
