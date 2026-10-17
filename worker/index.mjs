import {makeRoom,addPlayer,authFor,dispatch,publicView,expire,GameError} from './core.mjs';
const json = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const cors = {'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST,OPTIONS','access-control-max-age':'86400'};
const random = size => Array.from(crypto.getRandomValues(new Uint8Array(size)),x=>x.toString(16).padStart(2,'0')).join('');
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>alphabet[n%alphabet.length]).join('');
async function parse(request){ const text=await request.text();if(text.length>8000) throw new GameError('Request too large.',413);try{return JSON.parse(text||'{}');}catch{throw new GameError('Invalid JSON.');} }
function errorResponse(e){return json({error:e instanceof GameError?e.message:'Server error. Retry or contact the host.'},e instanceof GameError?e.status:500,cors);}
export default {
  async fetch(request,env){
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    const url=new URL(request.url), path=url.pathname;
    if(path==='/api/health') return json({ok:true,service:'two-rooms',time:Date.now()},200,cors);
    try {
      if(path==='/api/rooms' && request.method==='POST'){
        const body=await parse(request), count=body.playerCount;
        if(!Number.isInteger(count)||count<6||count>30)throw new GameError('Choose 6–30 players.');
        for(let attempt=0;attempt<5;attempt++){
          const code=roomCode(),token=random(32),id=env.ROOMS.idFromName(code);
          const response=await env.ROOMS.get(id).fetch('https://room.internal/init',{method:'POST',body:JSON.stringify({code,count,token})});
          if(response.status===409)continue;
          if(!response.ok)throw new GameError('Unable to create a room. Please retry.',503);
          return json({code,token},201,cors);
        }
        throw new GameError('Could not allocate a unique room. Retry.',503);
      }
      const match=path.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/(join|action|state|socket)$/);
      if(!match) return json({error:'Not found.'},404,cors);
      const [,code,operation]=match;
      if(operation==='socket' && request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new GameError('WebSocket upgrade required.',426);
      if(operation!=='socket' && request.method!=='POST')throw new GameError('POST required.',405);
      const id=env.ROOMS.idFromName(code);
      const result=await env.ROOMS.get(id).fetch(`https://room.internal/${operation}`,request);
      const headers=new Headers(result.headers);for(const [k,v] of Object.entries(cors))headers.set(k,v);
      return new Response(result.body,{status:result.status,statusText:result.statusText,headers,webSocket:result.webSocket});
    }catch(e){return errorResponse(e);}
  }
};
export class Room {
  constructor(state,env){
    this.state=state;this.env=env;this.game=null;this.queue=Promise.resolve();
    state.blockConcurrencyWhile(async()=>{this.game=await state.storage.get('game')||null;});
  }
  serialize(work){const task=this.queue.then(work);this.queue=task.catch(()=>{});return task;}
  async save(){await this.state.storage.put('game',this.game);await this.schedule();}
  async schedule(){
    if(this.game && ['ROUND','EXCHANGE'].includes(this.game.phase) && this.game.until)await this.state.storage.setAlarm(this.game.until);
    else await this.state.storage.deleteAlarm();
  }
  async fresh(now){if(this.game && expire(this.game,now)){this.game.revision++;await this.save();await this.broadcast();}}
  async fetch(request){
    const op=new URL(request.url).pathname.substring(1);
    if(op==='socket'){
      if(!this.game)return json({error:'Room does not exist.'},404);
      const pair=new WebSocketPair(),server=pair[1];this.state.acceptWebSocket(server);
      server.serializeAttachment({authenticated:false});
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    return this.serialize(async()=>{
      try{
        const now=Date.now();
        if(op==='init'){
          if(this.game)throw new GameError('Room already exists.',409);
          const body=await parse(request);this.game=makeRoom(body.code,body.count,body.token,now);
          await this.save();return json({ok:true},201);
        }
        if(!this.game)throw new GameError('Room not found or expired.',404);
        await this.fresh(now);
        const body=await parse(request);
        if(op==='join'){
          const id=crypto.randomUUID(),token=random(32);addPlayer(this.game,body.name,id,token,now);
          await this.save();await this.broadcast();return json({id,token,code:this.game.code},201);
        }
        const auth=authFor(this.game,body.token);
        if(op==='state')return json(publicView(this.game,auth,now));
        if(op==='action'){
          if(typeof body.requestId!=='string'||!/^[-\w]{8,80}$/.test(body.requestId)) throw new GameError('Request ID required.');
          const key=body.requestId;
          if(this.game.seen[key])return json({ok:true,revision:this.game.revision,duplicate:true});
          const response=dispatch(this.game,auth,body.action,body.payload||{},now,()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296);
          this.game.seen[key]=now;const keys=Object.keys(this.game.seen);if(keys.length>500)for(const k of keys.slice(0,keys.length-400))delete this.game.seen[k];
          await this.save();await this.broadcast();return json({ok:true,...response});
        }
        throw new GameError('Unknown room operation.',404);
      }catch(e){if(!(e instanceof GameError))console.error('Room request error',e?.message);return errorResponse(e);}
    });
  }
  async webSocketMessage(ws,message){
    return this.serialize(async()=>{
      try{
        const m=JSON.parse(String(message));
        const existing=ws.deserializeAttachment()||{};
        if(!existing.authenticated){
          if(m.type!=='hello')throw new GameError('Authenticate before subscribing.',401);
          if(!this.game)throw new GameError('Room no longer exists.',404);
          authFor(this.game,m.token);
          ws.serializeAttachment({authenticated:true,token:m.token});
          await this.fresh(Date.now());this.send(ws);return;
        }
        if(m.type==='ping'){ws.send(JSON.stringify({type:'pong',serverNow:Date.now()}));return;}
        if(m.type==='sync'){await this.fresh(Date.now());this.send(ws);return;}
        throw new GameError('Unsupported WebSocket message.');
      }catch(e){try{ws.send(JSON.stringify({type:'error',message:e?.message||'WebSocket error.'}));ws.close(1008,'Session invalid');}catch{}}
    });
  }
  send(ws){
    try{const token=ws.deserializeAttachment()?.token;if(!token)return;
      const auth=authFor(this.game,token);
      ws.send(JSON.stringify({type:'state',state:publicView(this.game,auth,Date.now())}));
    }catch{try{ws.close(1008,'Session invalid');}catch{}}
  }
  async broadcast(){for(const ws of this.state.getWebSockets())this.send(ws);}
  async alarm(){return this.serialize(async()=>{if(this.game){await this.fresh(Date.now());await this.schedule();}});}
  async webSocketClose(ws){try{ws.close();}catch{}}
}
