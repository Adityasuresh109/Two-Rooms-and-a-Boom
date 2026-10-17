import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeck,makeRoom,addPlayer,authFor,dispatch,publicView,hostageCount,expire,winner,resultOf,GameError} from '../worker/core.mjs';
let next=1;
const id=()=>`seat-${next++}`;
const rng=()=>0.438;
function setup(n){const s=makeRoom('ABC234',n,'host-secret',0);for(let i=0;i<n;i++)addPlayer(s,`Player ${i+1}`,id(),`token-${i+1}`,i);return s;}
const host=s=>authFor(s,'host-secret');
const who=(s,p)=>authFor(s,p.token);
const act=(s,p,a,x={},t=1000)=>dispatch(s,typeof p==='string'?authFor(s,p):p,a,x,t,rng);
const room=(s,r)=>s.players.filter(p=>p.room===r&&!p.removed);
function start(n){const s=setup(n);act(s,host(s),'start');act(s,host(s),'begin');return s;}
function nominate(s,r,now=1000){const players=room(s,r);if(!s.leaders[r])act(s,who(s,players[0]),'nominate',{id:players[1].id},now);return s.leaders[r];}
function pick(s,r,now=1100){nominate(s,r);const leader=s.players.find(p=>p.id===s.leaders[r]);const ids=room(s,r).filter(p=>p.id!==leader.id).slice(0,hostageCount(s.playerCount,s.round)).map(p=>p.id);act(s,who(s,leader),'pick',{ids},now);return ids;}
function finishRound(s,now){if(!s.locks.A)pick(s,'A',now-1000);if(!s.locks.B)pick(s,'B',now-1000);assert.equal(expire(s,now),true);assert.equal(s.phase,'EXCHANGE');assert.equal(expire(s,now+25000),true);assert.equal(s.phase,'EXCHANGE');act(s,host(s),'advance',{},now+25001);}
test('deck composition and official chart for all 6-30 players',()=>{
 for(let n=6;n<=30;n++){const deck=createDeck(n);assert.equal(deck.length,n);assert.equal(deck.filter(x=>x==='PRESIDENT').length,1);assert.equal(deck.filter(x=>x==='BOMBER').length,1);assert.equal(deck.filter(x=>x==='GAMBLER').length,n%2);assert.equal(deck.filter(x=>x==='BLUE').length,deck.filter(x=>x==='RED').length);}
 for(const [n,chart] of [[6,[1,1,1]],[10,[1,1,1]],[11,[2,1,1]],[21,[2,1,1]],[22,[3,2,1]],[25,[3,2,1]],[30,[3,2,1]]])assert.deepEqual([0,1,2].map(r=>hostageCount(n,r)),chart);
 for(const n of [0,5,31,30.5])assert.throws(()=>createDeck(n),GameError);
});
test('25 player deal, even-as-possible split, secret cards never broadcast',()=>{
 const s=start(25);assert.equal(s.phase,'ROUND');assert.deepEqual([room(s,'A').length,room(s,'B').length],[13,12]);
 assert.equal(new Set(s.players.map(p=>p.card)).size,5);
 const alice=s.players[0],bob=s.players[1];const a=publicView(s,who(s,alice),1000),h=publicView(s,host(s),1000);
 assert.equal(a.me.card,alice.card);assert.equal(a.players.filter(p=>p.card!==undefined).length,0);
 assert.equal(h.players.filter(p=>p.card!==undefined).length,0);
 assert.equal(a.players.every(p=>p.room===alice.room),true);
 assert.equal(a.players.find(p=>p.id===bob.id)?.card,undefined);
 assert.throws(()=>authFor(s,bob.id),/seat is unavailable/i);
});
test('initial nomination must be from another player and usurp requires strict majority',()=>{
 const s=start(10),r='A',members=room(s,r);
 assert.throws(()=>act(s,who(s,members[0]),'nominate',{id:members[0].id}),/another player/);
 nominate(s,r);const challenger=members[2];
 const threshold=Math.floor(members.length/2)+1;
 for(let i=0;i<threshold-1;i++)act(s,who(s,members[i]),'challenge',{id:challenger.id},1200+i);
 assert.notEqual(s.leaders[r],challenger.id);
 act(s,who(s,members[threshold-1]),'challenge',{id:challenger.id},1400);
 assert.equal(s.leaders[r],challenger.id);assert.deepEqual(s.votes[r],{});
});
test('abdication requires acceptance, can be declined, and cannot return in same round',()=>{
 const s=start(8),members=room(s,'A');nominate(s,'A');const leader=members.find(p=>p.id===s.leaders.A),next=members.find(p=>p.id!==leader.id);
 act(s,who(s,leader),'abdicate',{id:next.id});assert.equal(s.leaders.A,leader.id);
 act(s,who(s,next),'decline');assert.equal(s.leaders.A,leader.id);
 act(s,who(s,leader),'abdicate',{id:next.id});act(s,who(s,next),'accept');assert.equal(s.leaders.A,next.id);
 assert.throws(()=>act(s,who(s,next),'abdicate',{id:leader.id}),/Cannot pass/);
});
test('two-phase selection hides opposite picks until both lock AND time expires',()=>{
 const s=start(25);const picksA=pick(s,'A');const pB=room(s,'B')[0];const viewB=publicView(s,who(s,pB),2000);
 assert.equal(viewB.exchange,undefined);assert.equal(viewB.players.some(p=>p.room==='A'),false);
 assert.equal(viewB.me.pickIds,undefined);
 assert.deepEqual(s.locks.A.ids,picksA);assert.equal(s.locks.B,null);
 const b=pick(s,'B');assert.equal(s.phase,'ROUND');
 assert.equal(publicView(s,who(s,pB),2000).exchange,undefined);
 assert.equal(expire(s,181000),true);assert.equal(s.phase,'EXCHANGE');
 assert.deepEqual(s.exchange.A,picksA);assert.deepEqual(s.exchange.B,b);
 assert.equal(publicView(s,who(s,pB),181000).exchange.A.length,3);
 for(const p of s.players.filter(p=>p.pendingMove))assert.equal(p.room,picksA.includes(p.id)?'B':'A');
});
test('expiry forbids leader picks and host can force missing selections',()=>{
 const s=start(7);nominate(s,'A');nominate(s,'B');const leader=s.players.find(p=>p.id===s.leaders.A);
 assert.equal(expire(s,181000),true);assert.equal(s.phase,'LOCKING');
 assert.throws(()=>act(s,who(s,leader),'pick',{ids:[room(s,'A')[0].id]},181001),/action is closed/);
 for(const r of ['A','B']){const ids=room(s,r).filter(p=>p.id!==s.leaders[r]).slice(0,1).map(p=>p.id);act(s,host(s),'host-pick',{room:r,ids},181010);}
 assert.equal(s.phase,'EXCHANGE');
});
test('leader cannot be hostage, duplicates and incorrect counts rejected',()=>{
 const s=start(25);nominate(s,'A');const leader=s.players.find(p=>p.id===s.leaders.A);
 assert.throws(()=>act(s,who(s,leader),'pick',{ids:[leader.id,room(s,'A')[2].id,room(s,'A')[3].id]}),/cannot be its leader/);
 assert.throws(()=>act(s,who(s,leader),'pick',{ids:[room(s,'A')[0].id,room(s,'A')[0].id,room(s,'A')[0].id]}),/different hostage/);
 assert.throws(()=>act(s,who(s,leader),'pick',{ids:[room(s,'A')[0].id]}),/exactly 3/);
});
test('7 player gambler prediction must precede reveal and verdict matches winner',()=>{
 const s=start(7);for(let round=0;round<3;round++)finishRound(s,[181000,326010,411020][round]);
 assert.equal(s.phase,'PREDICTION');assert.throws(()=>act(s,host(s),'reveal'),/Wait for the Gambler/);
 const gambler=s.players.find(p=>p.card==='GAMBLER'),team=winner(s);
 act(s,who(s,gambler),'prediction',{team});assert.throws(()=>act(s,who(s,gambler),'prediction',{team}),/already locked/);
 act(s,host(s),'reveal');assert.equal(s.result.gambler.won,true);
 assert.equal(s.phase,'REVEALED');assert.equal(publicView(s,host(s)).players.filter(p=>p.card).length,7);
});
test('red / blue winner × Gambler right / wrong all four verdict scenarios',()=>{
 for(const together of [true,false])for(const correct of [true,false]){
  const s=start(7),pre=s.players.find(p=>p.card==='PRESIDENT'),bomb=s.players.find(p=>p.card==='BOMBER'),g=s.players.find(p=>p.card==='GAMBLER');
  pre.room='A';bomb.room=together?'A':'B';g.prediction=(together===correct)?'RED':'BLUE';
  const outcome=resultOf(s);assert.equal(outcome.winningTeam,together?'RED':'BLUE');assert.equal(outcome.gambler.won,correct);
 }
});
test('seat and secret card can be reclaimed after arbitrary refresh with same token',()=>{
 const s=start(25),p=s.players[5],token=p.token,initial=publicView(s,authFor(s,token),999);
 pick(s,'A');pick(s,'B');expire(s,181000);
 const reconnect=publicView(s,authFor(s,token),181001);
 assert.equal(reconnect.me.id,p.id);assert.equal(reconnect.me.card,initial.me.card);assert.equal(reconnect.me.room,p.room);
 assert.throws(()=>authFor(s,'wrong-token'),/unavailable/);
});
test('full 25 simulated-client game: three elections, three exchanges, live views and correct verdict',()=>{
 const s=start(25);const simulatedClients=new Map(s.players.map(p=>[p.id,p.token]));
 for(let r=0;r<3;r++){
  assert.equal(s.round,r);const time=[181000,326010,411020][r];
  for(const roomId of ['A','B']){nominate(s,roomId,time-100);const ids=pick(s,roomId,time-100);assert.equal(ids.length,[3,2,1][r]);}
  for(const p of s.players){const view=publicView(s,authFor(s,simulatedClients.get(p.id)),time-1);assert.equal(view.me.card,p.card);assert.equal(view.players.every(x=>x.card===undefined),true);}
  assert.equal(expire(s,time),true);assert.equal(s.phase,'EXCHANGE');
  for(const p of s.players.filter(p=>p.pendingMove))act(s,who(s,p),'ack-move',{},time+10);
  assert.equal(expire(s,time+25000),true);assert.equal(s.phase,'EXCHANGE');act(s,host(s),'advance',{},time+25001);
  assert.deepEqual([room(s,'A').length,room(s,'B').length],[13,12]);
 }
 const gambler=s.players.find(p=>p.card==='GAMBLER');act(s,who(s,gambler),'prediction',{team:winner(s)},411031);
 act(s,host(s),'reveal',{},411032);assert.equal(s.phase,'REVEALED');assert.equal(s.result.winningTeam,winner(s));
 for(const p of s.players)assert.equal(publicView(s,who(s,p),411033).players.filter(x=>x.card).length,25);
});
test('30 seats have equal split, three rounds and correct hostage counts',()=>{
 const s=start(30);assert.deepEqual([room(s,'A').length,room(s,'B').length],[15,15]);
 for(let r=0;r<3;r++){finishRound(s,[181000,326010,411020][r]);}
 assert.equal(s.phase,'FINAL_READY');act(s,host(s),'reveal');assert.equal(s.result.winningTeam,winner(s));
});
test('host removal revokes dropped seat but retains exact deck and card for fair count',()=>{
 const s=start(25),p=room(s,'A').find(p=>p.id!==s.leaders.A);
 const original=p.card;act(s,host(s),'remove',{id:p.id});
 assert.equal(s.players.length,25);assert.equal(p.card,original);assert.equal(p.removed,true);
 assert.throws(()=>authFor(s,p.token),/Missing authentication token/);
});
test('resend prompt increments nonce; host pause and resume freeze countdown',()=>{
 const s=start(8);nominate(s,'A');const p=s.players.find(x=>x.id===s.leaders.A);
 const before=p.promptNonce;act(s,host(s),'resend',{kind:'PICK',id:p.id});assert.equal(p.promptNonce,before+1);
 act(s,host(s),'pause',{},3000);assert.equal(s.phase,'PAUSED');assert.equal(s.timeLeft,178000);
 assert.equal(expire(s,1000000),false);act(s,host(s),'resume',{},1000000);assert.equal(s.until,1178000);
});
