"use client";
import {useEffect,useRef,useState} from "react";
import type {WebDavConfig,WebDavReport,SyncResolution} from "../lib/vault-api";
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
export function WebDavDialog({open,scope,web,onClose,onRun,onTest,onOpen}:{open:boolean;scope:string;web:boolean;onClose:()=>void;onRun:(config:WebDavConfig,resolutions:SyncResolution[])=>Promise<WebDavReport>;onTest:(config:WebDavConfig)=>Promise<void>;onOpen:(path:string)=>void}){
  const [config,setConfig]=useState<WebDavConfig>({url:"",username:"",password:"",remotePath:"Noto"});
  const [running,setRunning]=useState(false),[testing,setTesting]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[report,setReport]=useState<WebDavReport|null>(null),[choices,setChoices]=useState<Record<string,"local"|"remote">>({});
  const panel=useRef<HTMLDivElement>(null),flight=useRef(false),alive=useRef(true);const key="noto.webdav.v1:"+scope;
  useEffect(()=>{alive.current=true;try{const raw=localStorage.getItem(key);if(raw){const data=JSON.parse(raw);setConfig(previous=>({...previous,...Object.fromEntries(["url","username","remotePath"].flatMap(k=>typeof data[k]==="string"?[[k,data[k]]]:[]))}));}}catch{setError("无法读取本机 WebDAV 设置，请重新填写。");}return()=>{alive.current=false;};},[key]);
  useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;panel.current?.querySelector<HTMLElement>("button")?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[open]);
  function update(patch:Partial<WebDavConfig>){setConfig(current=>({...current,...patch}));setReport(null);setChoices({});setError("");setNotice("");}
  async function run(test=false){
    if(flight.current)return;flight.current=true;setError("");setNotice("");
    if(test)setTesting(true);else{setRunning(true);}
    const captured={...config};
    try{
      // Only connection metadata persists. Passwords never enter localStorage.
      try{localStorage.setItem(key,JSON.stringify({url:captured.url,username:captured.username,remotePath:captured.remotePath}));}catch{throw new Error("无法保存连接设置，请检查当前设备存储");}
      if(test){await onTest(captured);if(alive.current)setNotice("服务目录可访问；首次同步会创建远端子目录，写入时还会验证版本保护。");}
      else{
        const resolutions=(report?.conflicts??[]).flatMap(c=>choices[c.path]?[{path:c.path,localVersion:c.localVersion,remoteVersion:c.remoteVersion,choice:choices[c.path]}]:[]);
        const result=await onRun(captured,resolutions);
        if(alive.current){setReport(result);setChoices({});setNotice(result.errors.length||result.conflicts.length||result.skipped.length?"本轮同步已结束，下面的待处理项仍保留。":"本轮同步完成。");}
      }
    }catch(e){if(alive.current)setError(message(e));}
    finally{flight.current=false;if(alive.current){setRunning(false);setTesting(false);}}
  }
  if(!open)return null;
  const pending=running||testing;
  return <div className="modal-backdrop"><div className="webdav-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="webdav-title" onKeyDown={event=>{
    if(event.key==="Escape"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();onClose();}
    if(event.key==="Tab"){const items=[...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")??[])],first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  }}>
    <header><h2 id="webdav-title">WebDAV 同步</h2><button type="button" onClick={onClose}>{pending?"收起，继续后台处理":"关闭"}</button></header>
    <div className="webdav-scroll">
      <p>手动同步笔记、附件、知识画布和绘图白板。{web?"由当前网页服务连接 WebDAV 并同步挂载的知识库。":"当前知识库直接连接 WebDAV，离线编辑仍可使用。"}</p>
      <div className="webdav-fields"><label>服务地址<input type="url" value={config.url} disabled={pending} placeholder="https://nas.example.com/dav/" onChange={e=>update({url:e.target.value})}/></label><label>远端子目录<input value={config.remotePath} disabled={pending} onChange={e=>update({remotePath:e.target.value})}/></label><label>用户名<input autoComplete="off" value={config.username} disabled={pending} onChange={e=>update({username:e.target.value})}/></label><label>密码或应用密码<input type="password" autoComplete="off" value={config.password} disabled={pending} onChange={e=>update({password:e.target.value})}/></label></div>
      <p className="settings-hint">密码仅在当前运行中保留，不写入本机设置。首次同步会合并两边新增文件；同名内容不同会产生冲突副本。含未保存编辑、恢复草稿或在途导入的文档先跳过，请保存后再同步。</p>
      <p className="settings-hint">删除需要在冲突项中确认。隐藏数据和自动生成的 WebDAV 冲突副本不上传；副本整理或改名后可正常同步。单文件最多 64 MiB，每轮最多 10000 个文件。</p>
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {pending&&<p role="status">{testing?"正在测试连接…":"正在同步，可收起面板继续编辑。同步期间的新修改仍受草稿和版本检查保护。"}</p>}
      {report&&<section aria-label="同步结果"><p className="webdav-summary">上传 {report.uploaded} · 下载 {report.downloaded} · 本地删除 {report.deletedLocal} · 远端删除 {report.deletedRemote}</p>
        {!!report.conflicts.length&&<><h3>待处理冲突（{report.conflicts.length}）</h3><p className="settings-hint">先查看副本，再选择保留哪一端并点击“处理选中冲突”。未选择的文件继续保留；远端一端为删除时，采用该端会删除另一端。</p>{report.conflicts.map(c=><div className="webdav-conflict" key={c.path}><strong>{c.path}</strong><p>{c.reason}</p>{c.copy&&<button type="button" disabled={pending} onClick={()=>{onClose();onOpen(c.copy!);}}>打开远端副本</button>}<label>处理 {c.path}<select disabled={pending} value={choices[c.path]??""} onChange={e=>setChoices(previous=>({...previous,[c.path]:e.target.value as "local"|"remote"}))}><option value="">暂不处理</option><option value="local">保留本地{c.localVersion===null?"（删除远端）":"（更新远端）"}</option><option value="remote">采用远端{c.remoteVersion===null?"（删除本地）":"（更新本地）"}</option></select></label></div>)}</>}
        {!!report.skipped.length&&<details open><summary>跳过 {report.skipped.length} 个有编辑或草稿的文件</summary><ul>{report.skipped.map(path=><li key={path}>{path}</li>)}</ul></details>}
        {!!report.errors.length&&<section aria-label="同步失败项"><h3>未完成（{report.errors.length}）</h3>{report.errors.map((e,i)=><p key={i} role="alert"><strong>{e.path}</strong>：{e.message}</p>)}</section>}
      </section>}
    </div>
    <footer><button type="button" disabled={pending||!config.url||!config.remotePath} onClick={()=>{void run(true);}}>测试连接</button><span>自动保存和恢复草稿继续工作</span><button className="primary" type="button" disabled={pending||!config.url||!config.remotePath} onClick={()=>{void run();}}>{Object.values(choices).some(Boolean)?"处理选中冲突":"立即同步"}</button></footer>
  </div></div>;
}
