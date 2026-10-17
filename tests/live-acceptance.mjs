import assert from 'node:assert/strict';
const base='https://two-rooms-and-a-boom.adityasuresh2110.workers.dev';
const log=(...x)=>console.log(new Date().toISOString(),...x);
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(path+' '+r.status+' '+JSON.stringify(j));return j;}
async function action(code,token,action,payload={}){return post('/api/rooms/'+code+'/action',{token,action,payload,requestId:crypto.randomUUID()});}
async function state(code,token){return post('/api/rooms/'+code+'/state',{token});}
async function game(n,shrink=false){
 const room=await post('/api/rooms',{playerCount:n}),players=[];
 for(let i=0;i<n;i++){const p=await post('/api/rooms/'+room.code+'/join',{name:'QA Player '+(i+1)});players.push(p);}
 const host=room.token;
 if(shrink){await action(room.code,host,'remove',{id:players[0].id});await action(room.code,host,'set-count',{count:n-1});}
 await action(room.code,host,'start');let s=await state(room.code,host);assert.equal(s.phase,'TRAVEL');assert.equal(s.players.length,shrink?n-1:n);
 if(shrink)assert.deepEqual(s.players.map(p=>p.card).filter(Boolean),[]); // secret until reveal
 await action(room.code,host,'begin');
 for(let round=0;round<3;round++){
  s=await state(room.code,host);assert.equal(s.phase,'ROUND');
  await action(room.code,host,'force-advance');
  for(const r of ['A','B']){
   s=await state(room.code,host);
   const eligible=s.players.filter(p=>p.room===r&&!p.removed);
   const leader=s.leaders[r];
   const ids=eligible.filter(p=>p.id!==leader).slice(0,s.hostageCount).map(p=>p.id);
   assert.equal(ids.length,s.hostageCount,'Hostage selection '+r+' round '+round);
   await action(room.code,host,'host-pick',{room:r,ids});
  }
  s=await state(room.code,host);assert.equal(s.phase,'EXCHANGE');
  await action(room.code,host,'advance');
 }
 s=await state(room.code,host);
 if(s.phase==='PREDICTION'){
  let gambler=null;
  for(const p of players){try{const v=await state(room.code,p.token);if(v.me?.card==='GAMBLER'){gambler=p;break;}}catch{}}
  assert.ok(gambler);
  await action(room.code,gambler.token,'prediction',{team:'RED'});
 }else assert.equal(s.phase,'FINAL_READY');
 await action(room.code,host,'reveal');
 s=await state(room.code,host);assert.equal(s.phase,'REVEALED');assert.ok(['RED','BLUE'].includes(s.result.winningTeam));
 log('PASS full live game',n,'shrink',shrink,'code',room.code,'winner',s.result.winningTeam);
 return {room,players};
}
async function sockets(room,players){
 const urls=players.map(()=>base.replace('https://','wss://')+'/api/rooms/'+room.code+'/socket');
 const connected=await Promise.all(urls.map((url,i)=>new Promise((resolve,reject)=>{
  const ws=new WebSocket(url);const timeout=setTimeout(()=>{ws.close();reject(Error('socket timeout '+i));},12000);
  ws.onopen=()=>ws.send(JSON.stringify({type:'hello',token:players[i].token}));
  ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='state'){clearTimeout(timeout);resolve(ws);}else if(m.type==='error'){clearTimeout(timeout);reject(Error(m.message));}}catch(err){clearTimeout(timeout);reject(err);}};
  ws.onerror=()=>{clearTimeout(timeout);reject(Error('websocket error '+i));};
 })));
 log('PASS concurrent authenticated WebSockets',connected.length);
 connected.forEach(ws=>ws.close());
}
await post('/api/health',{}).catch(async()=>{const r=await fetch(base+'/api/health');assert.equal(r.status,200);assert.equal((await r.json()).ok,true);});
const small=await game(6,true);
const big=await game(25,false);
await sockets(big.room,big.players);
log('ALL LIVE CHECKS PASSED');
