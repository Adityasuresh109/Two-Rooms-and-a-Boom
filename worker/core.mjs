// Pure, auditable rules engine. Only the Durable Object persists and transmits state.
export const ROUND_SECONDS = [180, 120, 60];
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 30;
export const ROOMS = ['A', 'B'];
export const ACTIONS = Object.freeze(['join','start','begin','nominate','challenge','abdicate','accept','decline','pick','host-pick','force-advance','advance','ack-move','prediction','reveal','remove','host-leader','resend','pause','resume']);
export class GameError extends Error { constructor(message, status = 400) { super(message); this.name = 'GameError'; this.status = status; } }
const fail = (message, status) => { throw new GameError(message, status); };
export const safeName = name => typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0,24) : '';
export const hostageCount = (players, round) => players >= 22 ? [3,2,1][round] : players >= 11 ? [2,1,1][round] : 1;
export function createDeck(count) {
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) fail('Player count must be 6–30.');
  const ordinaryPerSide = Math.floor((count - 2) / 2);
  const deck = ['PRESIDENT','BOMBER', ...Array(ordinaryPerSide).fill('BLUE'), ...Array(ordinaryPerSide).fill('RED')];
  if (count % 2) deck.push('GAMBLER');
  if (deck.length !== count) fail('Internal deck count mismatch.',500);
  return deck;
}
export function shuffle(items, rand) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i+1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function makeRoom(code, playerCount, hostToken, now) {
  createDeck(playerCount);
  return {code, playerCount, hostToken, players:[], phase:'LOBBY', round:-1, until:null, timeLeft:null, leaders:{A:null,B:null}, offers:{A:null,B:null}, cannotReturn:{A:null,B:null}, votes:{A:{},B:{}}, locks:{A:null,B:null}, revealed:false, result:null, exchange:{A:[],B:[]}, events:[], createdAt:now, revision:0, seen:{}};
}
export const roomPlayers = (s, room) => s.players.filter(p=>p.room===room);
export function winner(s) {
  const president = s.players.find(p=>p.card==='PRESIDENT');
  const bomber = s.players.find(p=>p.card==='BOMBER');
  if (!president || !bomber || !president.room || !bomber.room) fail('Final roles or room assignments missing.',500);
  return president.room === bomber.room ? 'RED' : 'BLUE';
}
export function resultOf(s) {
  const winningTeam = winner(s), gambler = s.players.find(p=>p.card==='GAMBLER');
  return {winningTeam, presidentRoom:s.players.find(p=>p.card==='PRESIDENT').room, bomberRoom:s.players.find(p=>p.card==='BOMBER').room,
    gambler: gambler ? {name:gambler.name,prediction:gambler.prediction,won:gambler.prediction===winningTeam}:null};
}
export function authFor(s,token) {
  if (!token || typeof token!=='string') fail('Missing authentication token.',401);
  if (token===s.hostToken) return {host:true};
  const player=s.players.find(p=>p.token===token && !p.removed);
  if (!player) fail('This seat is unavailable. Ask the host for help.',403);
  return {host:false,id:player.id};
}
const self = (s,auth) => { if(auth.host) fail('Player action only.',403); const p=s.players.find(x=>x.id===auth.id); if(!p || p.removed) fail('Seat no longer active.',403); return p; };
const host = auth => { if (!auth.host) fail('Host only.',403); };
const inRound = (s,now) => { if(s.phase!=='ROUND' || now>=s.until) fail('This action is closed for the round.'); };
const inOwnRoom = (s,p,id) => { const target=s.players.find(x=>x.id===id && !x.removed && x.room===p.room); if(!target) fail('Choose someone in your own room.'); return target; };
const clearPolitics = (s,room) => { s.votes[room]={}; s.offers[room]=null; };
function initialLeader(s,p,targetId) {
  if(s.leaders[p.room]) fail('Your room already has a leader. Use Challenge instead.');
  if(targetId===p.id) fail('The first leader must be nominated by another player.');
  inOwnRoom(s,p,targetId);
  s.leaders[p.room]=targetId; clearPolitics(s,p.room);
}
function requireLeader(s,p) { if(s.leaders[p.room]!==p.id) fail('Only your room leader may do this.'); if(s.locks[p.room]) fail('Hostages are already locked.'); }
function setLeader(s,room,targetId) {
  if (s.locks[room]) fail('Leadership is frozen after hostage selection locks.');
  if (!roomPlayers(s,room).some(x=>x.id===targetId && !x.removed)) fail('The new leader must be in the room.');
  s.leaders[room]=targetId; clearPolitics(s,room);
}
function lock(s,room,ids,actor) {
  if(s.locks[room]) fail('Room already locked.');
  const count=hostageCount(s.playerCount,s.round), pool=roomPlayers(s,room);
  if(!Array.isArray(ids) || ids.length!==count || new Set(ids).size!==ids.length) fail(`Select exactly ${count} different hostage(s).`);
  if(ids.some(id=>!pool.some(p=>p.id===id && !p.removed) || id===s.leaders[room])) fail('Each hostage must be in the room and cannot be its leader.');
  s.locks[room]={ids:[...ids],by:actor};
  clearPolitics(s,room);
}
function exchange(s,now) {
  if(!s.locks.A || !s.locks.B || s.phase!=='LOCKING') return false;
  const a=s.locks.A.ids,b=s.locks.B.ids;
  s.exchange={A:a,B:b};
  for(const p of s.players){ if(a.includes(p.id)){p.room='B';p.pendingMove=true;p.promptNonce=(p.promptNonce||0)+1;} if(b.includes(p.id)){p.room='A';p.pendingMove=true;p.promptNonce=(p.promptNonce||0)+1;} }
  s.phase='EXCHANGE';s.until=now+25000;s.timeLeft=null; s.events.push({type:'EXCHANGE',round:s.round,at:now});
  return true;
}
export function expire(s,now) {
  if(s.phase==='ROUND' && now>=s.until) { s.phase='LOCKING';s.until=null;s.timeLeft=null;s.events.push({type:'TIME_UP',round:s.round,at:now}); exchange(s,now); return true; }
  if(s.phase==='EXCHANGE' && now>=s.until){
    s.locks={A:null,B:null}; s.votes={A:{},B:{}};s.offers={A:null,B:null};s.cannotReturn={A:null,B:null};
    if(s.round===2){s.phase=s.players.some(p=>p.card==='GAMBLER')?'PREDICTION':'FINAL_READY';s.until=null;}
    else{ s.round++;s.phase='ROUND';s.until=now+ROUND_SECONDS[s.round]*1000; }
    s.events.push({type:'NEXT',round:s.round,at:now});return true;
  }
  return false;
}
const mark = (s,now) => { s.revision++;s.events=s.events.slice(-60);s.lastChange=now; };
export function dispatch(s,auth,action,payload={},now=Date.now(),rng=Math.random) {
  if(!ACTIONS.includes(action)) fail('Unknown action.');
  const oldPhase=s.phase, priorRevision=s.revision;
  switch(action) {
    case 'join': { fail('Join via the room join endpoint.',405); break; }
    case 'start': {
      host(auth); if(s.phase!=='LOBBY') fail('This game has started.');
      if(s.players.length!==s.playerCount) fail(`Waiting for ${s.playerCount-s.players.length} player(s).`);
      const deck=shuffle(createDeck(s.playerCount),rng), split=shuffle([...Array(s.playerCount)].map((_,i)=>i < Math.ceil(s.playerCount/2) ? 'A':'B'),rng);
      s.players.forEach((p,i)=>{p.card=deck[i];p.room=split[i];p.pendingMove=false;p.prediction=null;p.promptNonce=0;});
      s.phase='TRAVEL';s.round=-1;s.events.push({type:'DEALT',at:now});break;
    }
    case 'begin': {
      host(auth);if(s.phase!=='TRAVEL')fail('The game is not ready to begin.');
      s.phase='ROUND';s.round=0;s.until=now+ROUND_SECONDS[0]*1000;break;
    }
    case 'nominate': {
      const p=self(s,auth);inRound(s,now); if(s.locks[p.room])fail('Hostages already locked.'); initialLeader(s,p,payload.id);break;
    }
    case 'challenge': {
      const p=self(s,auth);inRound(s,now);if(!s.leaders[p.room])fail('Nominate a leader first.');if(s.locks[p.room])fail('Hostages already locked.');
      const t=inOwnRoom(s,p,payload.id);if(t.id===s.leaders[p.room])fail('Choose someone other than the current leader.');
      s.votes[p.room][p.id]=t.id;
      const ballots=Object.values(s.votes[p.room]).filter(x=>x===t.id).length;
      if(ballots>roomPlayers(s,p.room).length/2) setLeader(s,p.room,t.id);
      break;
    }
    case 'abdicate': {
      const p=self(s,auth);inRound(s,now);requireLeader(s,p);
      const t=inOwnRoom(s,p,payload.id);if(t.id===p.id)fail('Choose a different player.');
      if(s.cannotReturn[p.room]===t.id)fail('Cannot pass leadership back during this round.');
      s.offers[p.room]={from:p.id,to:t.id};break;
    }
    case 'accept': case 'decline': {
      const p=self(s,auth);inRound(s,now);const offer=s.offers[p.room];
      if(!offer || offer.to!==p.id)fail('There is no leadership offer for you.');
      if(action==='accept'){s.cannotReturn[p.room]=offer.from;setLeader(s,p.room,p.id);}else{s.offers[p.room]=null;}
      break;
    }
    case 'pick': {
      const p=self(s,auth);inRound(s,now);requireLeader(s,p);lock(s,p.room,payload.ids,p.id);break;
    }
    case 'host-pick': {
      host(auth);if(s.phase!=='LOCKING')fail('Host can select missed hostages after the timer expires.');
      if(!ROOMS.includes(payload.room))fail('Invalid room.');
      if(!s.leaders[payload.room])fail('Assign a leader first.');
      lock(s,payload.room,payload.ids,'HOST');exchange(s,now);break;
    }
    case 'force-advance': {
      host(auth);if(s.phase!=='ROUND')fail('Only a live round can be ended.');
      s.phase='LOCKING';s.until=null;s.timeLeft=null;exchange(s,now);break;
    }
    case 'advance': {
      host(auth);if(s.phase!=='EXCHANGE')fail('Only an exchange can be accelerated.');
      s.until=now;expire(s,now);break;
    }
    case 'ack-move': {const p=self(s,auth);if(!p.pendingMove)fail('No move is pending.');p.pendingMove=false;break;}
    case 'prediction': {
      const p=self(s,auth);if(p.card!=='GAMBLER'||s.phase!=='PREDICTION')fail('Only the Gambler can predict before the reveal.');
      if(p.prediction)fail('Your prediction is already locked.');
      if(!['RED','BLUE'].includes(payload.team))fail('Choose Red or Blue.');p.prediction=payload.team;break;
    }
    case 'reveal': {
      host(auth);if(s.phase!=='FINAL_READY' && s.phase!=='PREDICTION')fail('Finish the final exchange first.');
      if(s.phase==='PREDICTION' && !s.players.some(p=>p.card==='GAMBLER' && p.prediction))fail('Wait for the Gambler to lock a prediction.');
      s.result=resultOf(s);s.phase='REVEALED';s.revealed=true;s.until=null;break;
    }
    case 'remove': {
      host(auth);const p=s.players.find(p=>p.id===payload.id&&!p.removed);if(!p)fail('Player not found.');
      if(s.phase==='LOBBY')s.players=s.players.filter(x=>x.id!==p.id);
      else {p.removed=true;p.token=null;p.pendingMove=false; /* Keep original seat and card for fair deck and hostage counts */ }
      break;
    }
    case 'host-leader': {
      host(auth);if(s.phase!=='ROUND'&&s.phase!=='LOCKING')fail('No active leadership to recover.');
      if(!ROOMS.includes(payload.room))fail('Invalid room.');setLeader(s,payload.room,payload.id);break;
    }
    case 'resend': {
      host(auth);const p=s.players.find(x=>x.id===payload.id&&!x.removed);if(!p)fail('Player not found.');
      if(payload.kind==='MOVE' && !p.pendingMove)fail('This player has no pending move.');
      if(payload.kind==='PICK' && (s.phase!=='ROUND'||s.leaders[p.room]!==p.id||s.locks[p.room]))fail('This leader has no active pick prompt.');
      if(!['MOVE','PICK'].includes(payload.kind))fail('Invalid prompt type.');
      p.promptNonce=(p.promptNonce||0)+1;break;
    }
    case 'pause': {
      host(auth);if(s.phase!=='ROUND')fail('Only a running round can be paused.');
      s.timeLeft=Math.max(0,s.until-now);s.until=null;s.phase='PAUSED';break;
    }
    case 'resume': {
      host(auth);if(s.phase!=='PAUSED')fail('Not paused.');
      s.until=now+s.timeLeft;s.timeLeft=null;s.phase='ROUND';break;
    }
  }
  if(s.revision===priorRevision) mark(s,now);
  return {event:action,changed:oldPhase!==s.phase,revision:s.revision};
}
export function addPlayer(s,name,id,token,now){
  if(s.phase!=='LOBBY') fail('This game has already started.',409);
  if(s.players.length>=s.playerCount)fail('Room is full.',409);
  const clean=safeName(name);if(clean.length<2)fail('Enter at least 2 characters for your name.');
  if(s.players.some(p=>p.name.toLowerCase()===clean.toLowerCase())) fail('That name is already taken.');
  s.players.push({id,token,name:clean,room:null,card:null,removed:false,pendingMove:false,promptNonce:0,prediction:null});mark(s,now);
}
export function publicView(s,auth,now=Date.now()) {
  const you=auth.host?null:s.players.find(p=>p.id===auth.id && !p.removed);
  if(!auth.host&&!you)fail('Seat was removed.',403);
  const open=s.phase==='REVEALED';
  const publicPlayers=s.players.map(p=>({id:p.id,name:p.name,room:p.room,removed:p.removed,pendingMove:auth.host?p.pendingMove:undefined,card:open?p.card:undefined}));
  const same=(auth.host||open)?publicPlayers:publicPlayers.filter(p=>p.room===you.room || !you.room);
  const view={code:s.code,target:s.playerCount,joined:s.players.filter(p=>!p.removed).length,phase:s.phase,round:s.round+1,
    until:s.until,serverNow:now,timeLeft:s.timeLeft,revision:s.revision,players:same,leaders:auth.host?s.leaders:(you.room?{[you.room]:s.leaders[you.room]}:{}),
    voteCounts: auth.host ? {A:countVotes(s,'A'),B:countVotes(s,'B')} : you.room?{[you.room]:countVotes(s,you.room)}:{},
    locked:auth.host?{A:!!s.locks.A,B:!!s.locks.B}:(you.room?{[you.room]:!!s.locks[you.room]}:{}),needHost: auth.host&&s.phase==='LOCKING'?ROOMS.filter(r=>!s.locks[r]):[],
    hostageCount:s.round>=0?hostageCount(s.playerCount,s.round):null,
    exchange:s.phase==='EXCHANGE'||s.phase==='PREDICTION'||s.phase==='FINAL_READY'||open ? s.exchange : undefined,
    result:open?s.result:null};
  if(auth.host){view.host=true; view.players=publicPlayers;view.unavailable=s.players.filter(p=>p.removed).length;}
  else {view.host=false;view.me={id:you.id,name:you.name,room:you.room,card:you.card,removed:you.removed,pendingMove:you.pendingMove,
    promptNonce:you.promptNonce,prediction:you.prediction,offer:s.offers[you.room]?.to===you.id,leader:s.leaders[you.room]===you.id,
    vote:s.votes[you.room]?.[you.id]||null,locked:!!s.locks[you.room],pickIds:s.locks[you.room]?.by===you.id?s.locks[you.room].ids:undefined};
    // Never send the opposing room's hostage ids prior to BOTH locks and expiry.
    if(s.phase==='ROUND'||s.phase==='PAUSED'||s.phase==='LOCKING'){delete view.exchange;}
  }
  return view;
}
function countVotes(s,room){const counts={};for(const target of Object.values(s.votes[room]))counts[target]=(counts[target]||0)+1;return counts;}
