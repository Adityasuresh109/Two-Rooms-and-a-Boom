import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{Room} from '../worker/index.mjs';
class MemoryStorage {
 constructor(){this.data=new Map();this.alarm=null;}
 async get(k){return structuredClone(this.data.get(k));}
 async put(k,v){this.data.set(k,structuredClone(v));}
 async setAlarm(at){this.alarm=at;}
 async deleteAlarm(){this.alarm=null;}
}
class FakeState {
 constructor(){this.storage=new MemoryStorage();this.webSockets=[];}
 blockConcurrencyWhile(fn){this.ready=fn();}
 getWebSockets(){return this.webSockets;}
 acceptWebSocket(ws){this.webSockets.push(ws);}
}
class FakeNamespace {
 constructor(){this.map=new Map();}
 idFromName(code){return code;}
 get(id){if(!this.map.has(id)){const ctx=new FakeState();const instance=new Room(ctx,{});this.map.set(id,{instance,ctx});}
   const {instance,ctx}=this.map.get(id);
   return {fetch:async(url,original)=>{await ctx.ready;const req=new Request(url,{method:original.method,body:original.method==='GET'?null:original.body,headers:original.headers,duplex:'half'});return instance.fetch(req);}};
 }
}
const ns=new FakeNamespace();const env={ROOMS:ns};
async function post(path,body){const res=await worker.fetch(new Request('https://game.local'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),env);return {status:res.status,body:await res.json()};}
test('real Worker HTTP router: create, 7 joins, privacy, host token protection, seat reclaim',async()=>{
 const create=await post('/api/rooms',{playerCount:7});assert.equal(create.status,201);
 const {code,token:hostToken}=create.body;const seats=[];
 for(let i=0;i<7;i++){const join=await post(`/api/rooms/${code}/join`,{name:`Guest ${i}`});assert.equal(join.status,201);seats.push(join.body.token);}
 const full=await post(`/api/rooms/${code}/join`,{name:'Extra'});assert.equal(full.status,409);
 const forbidden=await post(`/api/rooms/${code}/action`,{token:seats[0],requestId:'not-host-123',action:'start'});assert.equal(forbidden.status,403);
 const start=await post(`/api/rooms/${code}/action`,{token:hostToken,requestId:'host-start-123',action:'start'});assert.equal(start.status,200);
 const repeat=await post(`/api/rooms/${code}/action`,{token:hostToken,requestId:'host-start-123',action:'start'});assert.equal(repeat.status,200);assert.equal(repeat.body.duplicate,true);
 const h=await post(`/api/rooms/${code}/state`,{token:hostToken});assert.equal(h.body.players.some(p=>p.card!==undefined),false);
 for(const token of seats){const view=await post(`/api/rooms/${code}/state`,{token});assert.equal(view.status,200);assert.ok(view.body.me.card);assert.equal(view.body.players.some(p=>p.card!==undefined),false);}
 const unauth=await post(`/api/rooms/${code}/state`,{token:'wrong'});assert.equal(unauth.status,403);
 const retry=await post(`/api/rooms/${code}/state`,{token:seats[0]});assert.equal(retry.body.me.card,(await post(`/api/rooms/${code}/state`,{token:seats[0]})).body.me.card);
 assert.equal(ns.map.get(code).ctx.storage.data.get('game').players.length,7);
});
test('HTTP health endpoint, invalid JSON count, and impossible routes fail loudly',async()=>{
 const health=await worker.fetch(new Request('https://game.local/api/health'),env);assert.equal((await health.json()).ok,true);
 assert.equal((await post('/api/rooms',{playerCount:5})).status,400);
 assert.equal((await post('/api/rooms/NOTREAL/state',{token:'x'})).status,404);
});
