import type {Note,VaultApi} from "./vault-api";

type Waiter={cancelled:()=>boolean;resolve:(note:Note)=>void;reject:(error:unknown)=>void};
type Job={key:string;path:string;waiters:Waiter[]};
type Pool={active:number;queue:Job[];jobs:Map<string,Job>};
const pools=new WeakMap<Pick<VaultApi,"read">,Pool>();

// Pool only in-flight reads, never saved content. Each waiter has its own
// lifetime; an old vault's queued work is discarded before invoking read.
export function readEmbedSaved(api:Pick<VaultApi,"read">,scope:string,path:string,cancelled:()=>boolean):Promise<Note>{
 let pool=pools.get(api);if(!pool){pool={active:0,queue:[],jobs:new Map()};pools.set(api,pool);}
 const owner=pool,key=scope+"\0"+path;
 let job=owner.jobs.get(key);
 if(!job){job={key,path,waiters:[]};owner.jobs.set(key,job);owner.queue.push(job);}
 const result=new Promise<Note>((resolve,reject)=>job!.waiters.push({cancelled,resolve,reject}));
 function pump(){
  while(owner.active<4&&owner.queue.length){
   const current=owner.queue.shift()!;
   if(current.waiters.every(waiter=>waiter.cancelled())){
    owner.jobs.delete(current.key);for(const waiter of current.waiters)waiter.reject(new Error("嵌入读取已取消"));continue;
   }
   owner.active++;
   void Promise.resolve().then(()=>api.read(current.path)).then(note=>{
    if(owner.jobs.get(current.key)===current)owner.jobs.delete(current.key);
    for(const waiter of current.waiters)waiter.cancelled()?waiter.reject(new Error("嵌入读取已取消")):waiter.resolve(note);
   },error=>{if(owner.jobs.get(current.key)===current)owner.jobs.delete(current.key);for(const waiter of current.waiters)waiter.reject(error);}).finally(()=>{owner.active--;pump();});
  }
 }
 pump();return result;
}
