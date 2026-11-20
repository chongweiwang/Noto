
import DOMPurify from "dompurify";
export const maxExportBytes = 64 * 1024 * 1024;
export const maxImageBytes = 32 * 1024 * 1024;
export function checkCancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("导出已取消", "AbortError"); }
export async function bounded<T>(promise: Promise<T>, signal?: AbortSignal, timeout = 30000): Promise<T> {
  checkCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let settled=false;
    const finish=(complete:()=>void)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);signal?.removeEventListener("abort",cancel);
      complete();
    };
    const cancel=()=>finish(()=>reject(new DOMException("导出已取消","AbortError")));
    const timer=setTimeout(()=>finish(()=>reject(new Error("导出资源准备超时，请重试"))),timeout);
    signal?.addEventListener("abort",cancel,{once:true});
    promise.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
  });
}
export function base64Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i=0;i<bytes.length;i+=16384) binary += String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(binary);
}
export function safeExportImage(uri: string) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml));base64,([a-z\d+/]*={0,2})$/i.exec(uri);
  if (!match || match[2].length > Math.ceil(maxImageBytes/3)*4) throw new Error("图片类型或大小不支持");
  if (match[1].toLowerCase() !== "image/svg+xml") return uri;
  const svg = new TextDecoder().decode(Uint8Array.from(atob(match[2]),(c)=>c.charCodeAt(0)));
  const externalCss=[...svg.matchAll(/url\(\s*([^)]*)\)/gi)].some((match)=>!match[1].trim().replace(/^['"]|['"]$/g,"").startsWith("#"));
  if (/<(?:script|foreignObject|image|iframe|object)\b|@import|(?:href|src)\s*=\s*["'](?!#)/i.test(svg)||externalCss) throw new Error("SVG 包含不支持的外部或交互内容");
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES:{svg:true,svgFilters:true}, ADD_TAGS:["style"], FORBID_TAGS:["script","foreignObject","image","a"], FORBID_ATTR:["onload","onclick"] });
  return "data:image/svg+xml;base64,"+base64Text(clean);
}
export async function decodeExportImage(uri: string, signal?: AbortSignal) {
  checkCancelled(signal);
  const img = new Image();
  const loading = new Promise<void>((resolve,reject) => { img.onload=()=>resolve(); img.onerror=()=>reject(new Error("图片无法解码")); });
  loading.catch(()=>{});
  img.src=uri;
  try { await bounded(typeof img.decode === "function" ? img.decode() : loading, signal); }
  finally { img.onload=null; img.onerror=null; img.removeAttribute("src"); }
}
