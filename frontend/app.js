const root=document.getElementById('app');
const banner=document.getElementById('connection');
const toastEl=document.getElementById('toast');
const API=(window.GAME_API_ORIGIN||'').replace(/\/$/,'');
const configured=/^https:\/\//.test(API)||/^http:\/\/localhost/.test(API);
const keyHost='trb-host-v1',seatPrefix='trb-seat-v1-';
let session=null,state=null,ws=null,connected=false,waiting=false,peek=false,clockOffset=0,attempt=0,retryTimer=null,lastMessageAt=0;
let picked=new Set(),hostPicked={A:new Set(),B:new Set()},travelDismissed=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const person=(id)=>state?.players.find(p=>p.id===id);
const codeFromHash=()=>{const m=location.hash.match(/(?:^#|[&?])join=([A-HJ-NP-Z2-9]{6})/i);return m?.[1]?.toUpperCase()||'';};
let landingTab=codeFromHash()?'join':'host';
let rulesOpen=false;
let countAdjustOpen=false;
function rulesContent(){return `<div class="rules-card" role="dialog" aria-modal="true" aria-label="How to play">
<button class="ghost small rules-x" data-action="rules-x" type="button" aria-label="Close">✕</button>
<div class="eyebrow">HOW TO PLAY</div><h2>Two Rooms &amp; a Boom</h2>
<div class="rules-body">
<div><b>The secret teams.</b><span>Everyone gets a hidden card: red team or blue team. The <b class="bluetext">President</b> leads blue, the <b class="redtext">Bomber</b> leads red. With an odd number of players, one person is the <b>Gambler</b>.</span></div>
<div><b>The goal.</b><span>When the game ends, if the President and the Bomber are in the <b>same</b> room, <b class="redtext">red wins</b>. If they're in <b>different</b> rooms, <b class="bluetext">blue wins</b>. The Gambler wins alone by predicting the winner before the reveal.</span></div>
<div><b>Your card is secret.</b><span>Hold your card to peek at it. Share as much or as little as you like — bluffing is part of the game.</span></div>
<div><b>Three rounds.</b><span>Each round is timed. When time runs out, each room's leader picks <b>hostages</b> who swap rooms. That's how the President and Bomber move around.</span></div>
<div><b>Leaders.</b><span>Each room picks a leader. A majority can overthrow the leader at any time and choose a new one.</span></div>
<div><b>The finale.</b><span>After the third swap, everyone reveals their cards at the same time. Then: boom, or no boom.</span></div>
</div></div>`;}
function rulesOverlay(){return rulesOpen?`<div class="rules-backdrop" data-action="rules-close">${rulesContent()}</div>`:'';}
function store(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
function read(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
function forget(key){try{localStorage.removeItem(key);}catch{}}
function joinLink(){return `${location.origin}${location.pathname}#join=${session.code}`;}
function notify(message){toastEl.textContent=message;toastEl.hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>toastEl.hidden=true,4500);}
function offline(reason){connected=false;banner.hidden=false;banner.querySelector('p').textContent=reason||'Your seat and card are safe. Reconnect to continue.';}
function online(){connected=true;banner.hidden=true;attempt=0;lastMessageAt=Date.now();}
const delay=t=>new Promise(r=>setTimeout(r,t));
async function request(path,body){
  if(!configured)throw new Error('The realtime backend is not configured. Deploy the Worker and update config.js.');
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),9000);
  try{
    const response=await fetch(`${API}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:ctl.signal,cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||`Server error ${response.status}.`);
    return data;
  }catch(e){if(e.name==='AbortError')throw new Error('Backend request timed out. Retry.');throw e;}finally{clearTimeout(timer);}
}
function wsEndpoint(){return `${API.replace(/^http/,'ws')}/api/rooms/${session.code}/socket`;}
function stopConnection(){clearTimeout(retryTimer);if(ws){const old=ws;ws=null;try{old.close(1000,'Leaving');}catch{}}connected=false;}
function reconnectSoon(){
  if(!session)return;clearTimeout(retryTimer);const ms=Math.min(12000,600*Math.pow(1.65,attempt++));
  retryTimer=setTimeout(()=>{if(session)connect();},ms);
}
async function connect(){
  if(!session)return;stopConnection();
  if(!configured){offline('Backend not configured. The game cannot run until deployment is complete.');return;}
  try{
    const snapshot=await request(`/api/rooms/${session.code}/state`,{token:session.token});update(snapshot);
    const socket=new WebSocket(wsEndpoint());ws=socket;
    const timeout=setTimeout(()=>{if(ws===socket&&socket.readyState!==WebSocket.OPEN)socket.close();},9000);
    socket.addEventListener('open',()=>{clearTimeout(timeout);if(ws===socket)socket.send(JSON.stringify({type:'hello',token:session.token}));});
    socket.addEventListener('message',event=>{
      if(ws!==socket)return;
      try{
        const m=JSON.parse(event.data);
        if(m.type==='state'){update(m.state);online();}
        else if(m.type==='pong')online();
        else if(m.type==='error'){offline(m.message);notify(m.message);}
      }catch{offline('Could not read server update. Retry.');}
    });
    socket.addEventListener('close',()=>{clearTimeout(timeout);if(ws!==socket)return;offline('Live connection lost. Reconnecting automatically…');reconnectSoon();});
    socket.addEventListener('error',()=>{if(ws===socket)offline('Realtime backend unreachable. Retry.');});
  }catch(e){offline(e.message);reconnectSoon();}
}
function update(snapshot){
  if(!snapshot || typeof snapshot.revision!=='number')throw new Error('Invalid server state.');
  const previous=state;
  clockOffset=Date.now()-snapshot.serverNow;
  state=snapshot;peek=false;
  if(previous?.me && state.me && previous.me.promptNonce!==state.me.promptNonce && state.me.promptNonce){notify(state.me.pendingMove?'HOST: MOVE TO YOUR NEW ROOM NOW.':'HOST: PLEASE MAKE YOUR HOSTAGE SELECTION.');try{navigator.vibrate?.([90,55,90]);}catch{}}
  if(previous && (previous.round!==state.round ||previous.phase!==state.phase)){picked.clear();hostPicked={A:new Set(),B:new Set()};if(state.phase!=='TRAVEL')travelDismissed=false;}
  render();tick();
}
async function command(action,payload={}){
  if(!session || waiting)return;
  waiting=true;
  try{const requestId=crypto.randomUUID();await request(`/api/rooms/${session.code}/action`,{token:session.token,requestId,action,payload});
    if(!connected){await refresh();}
  }catch(e){notify(e.message);if(/timed out|Failed to fetch|NetworkError|backend/i.test(e.message))offline(e.message);}finally{waiting=false;}
}
async function refresh(){if(!session)return;try{update(await request(`/api/rooms/${session.code}/state`,{token:session.token}));}catch(e){offline(e.message);}}
function beginSession(role,code,token){session={role,code,token};state=null;rulesOpen=false;countAdjustOpen=false;picked=new Set();hostPicked={A:new Set(),B:new Set()};render();connect();}
function timerText(){if(!state)return '--:--';const until=state.phase==='PAUSED'?(state.timeLeft||0):state.until?Math.max(0,state.until-(Date.now()-clockOffset)):0;
  const secs=Math.ceil(until/1000);return `${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;}
function tick(){for(const el of root.querySelectorAll('[data-countdown]'))el.textContent=timerText();}
setInterval(()=>{
  tick();if(session&&ws?.readyState===WebSocket.OPEN){
    if(Date.now()-lastMessageAt>20000){offline('No heartbeat from the backend. Reconnecting…');try{ws.close();}catch{}}
    else if(Date.now()-lastMessageAt>8000){try{ws.send(JSON.stringify({type:'ping'}));}catch{}}
  }
},1000);
document.getElementById('retry').addEventListener('click',()=>{attempt=0;connect();});
const btn=(label,act,payload={},cls='secondary')=>`<button class="${cls}" data-action="${esc(act)}" data-data="${esc(JSON.stringify(payload))}" type="button">${esc(label)}</button>`;
const panel=(content,cls='')=>`<section class="panel ${cls}">${content}</section>`;
function header(){return `<header class="top"><div class="brand">AD ARCADE <span class="muted">/</span> TWO ROOMS & A BOOM</div>${session?`<div class="row header-actions">${btn('?','rules-open',{},'ghost small rules-btn')}<button class="ghost small rules-btn" data-action="leave" data-data="{}" type="button" title="Leave game" aria-label="Leave game">⏻</button></div>`:''}</header>`;}
function qrSvg(text){
  try{const q=window.makeQR(text),n=q.getModuleCount(),cells=[];
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(q.isDark(y,x))cells.push(`<rect x="${x+4}" y="${y+4}" width="1" height="1"/>`);
    return `<div class="qr" role="img" aria-label="QR code for joining room ${esc(session.code)}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+8} ${n+8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${cells.join('')}</g></svg></div>`;
  }catch{return '<p role="alert">QR unavailable. Use the room code or copy the link.</p>';}
}
function startPage(){
 const joining=codeFromHash(),remembered=joining?read(seatPrefix+joining):null;
 const hostTab=landingTab==='host';
 const content=hostTab?`<h2>HOST A PARTY</h2><form id="create-form" class="stack"><label for="count">Player count (host doesn't play)</label><input id="count" type="number" min="6" max="30" value="25" required><button class="primary" type="submit">CREATE GAME</button></form>${read(keyHost)?`<div class="spaced">${btn('RESUME LAST SESSION','restore-host',{},'ghost')}</div>`:''}<p class="help">Open this on your laptop or TV. Players join from their phones — nothing to install.</p>`:
 `<h2>JOIN THE PARTY</h2><form id="join-form" class="stack"><label for="room-code">Room code</label><input id="room-code" name="room" value="${esc(joining)}" maxlength="6" minlength="6" autocomplete="off" autocapitalize="characters" required><label for="player-name">Your name</label><input id="player-name" name="name" maxlength="24" minlength="2" required><button class="primary" type="submit">JOIN ROOM</button></form>${remembered?.token?`<div class="spaced">${btn('RECLAIM MY SEAT','restore-player',{code:joining},'ghost')}</div>`:''}<p class="help">Fastest way in: scan the QR code on the host's screen.</p>`;
 return `<div class="shell landing"><header class="top"><div class="brand">AD ARCADE</div></header><section class="landing-hero"><h1>TWO ROOMS<br><span class="gold">&amp;</span> A BOOM</h1><p>Two teams. Two rooms. Three rounds. One secret in every pocket — and one boom at the end.</p><div class="team-split"><span></span><span></span></div><div class="center" style="margin-top:18px"><button class="ghost" data-action="rules-open" type="button">HOW TO PLAY</button></div></section>
 <div class="landing-form"><div class="landing-tabs" role="tablist"><button type="button" role="tab" aria-selected="${hostTab}" class="${hostTab?'active':''}" data-action="landing-tab" data-data='{"tab":"host"}'>I'M HOSTING</button><button type="button" role="tab" aria-selected="${!hostTab}" class="${!hostTab?'active':''}" data-action="landing-tab" data-data='{"tab":"join"}'>I'M JOINING</button></div>
 ${!configured?panel('<strong>Backend not configured.</strong><p>Realtime play is unavailable until the Cloudflare Worker is deployed.</p>','warn'):''}${panel(content)}</div>
 <section class="how-strip">${['Split into two physical rooms','Everyone gets a secret card','Three timed rounds, hostages swap','Bomber meets President? Boom.'].map((x,i)=>`<div><b>${i+1}</b><span>${x}</span></div>`).join('')}</section>${footer()}</div>`;
}
function footer(){return `<footer>Unofficial fan adaptation of the tabletop game by Alan Gerding &amp; Sean McCoy.</footer>`;}
function nameList(room,hostControls=false){
  const list=state.players.filter(p=>p.room===room);const leader=state.leaders[room];
  return `<div class="roster">${list.map(p=>`<div class="person ${leader===p.id?'leader':''} ${p.removed?'removed':''}"><div><b>${esc(p.name)}</b> ${leader===p.id?'<span class="tag">★ LEADER</span>':''} ${p.removed?'<span class="tag">REMOVED</span>':''}${state.phase==='REVEALED'?`<p class="tag">${esc(p.card)}</p>`:''}</div>${hostControls?`<div class="row">${['ROUND','LOCKING'].includes(state.phase)&&!p.removed&& !state.locked[room]?btn('LEADER','host-leader',{room,id:p.id},'small secondary'):''}${p.id===leader&&state.phase==='ROUND'?btn('PICK PROMPT','resend',{id:p.id,kind:'PICK'},'small ghost'):''}${p.pendingMove?btn('MOVE PROMPT','resend',{id:p.id,kind:'MOVE'},'small ghost'):''}${!p.removed&&p.id!==leader?btn('REMOVE','remove',{id:p.id},'small danger'):''}${p.removed?'':p.id===leader&&state.phase!=='LOBBY'?btn('REMOVE','remove',{id:p.id},'small danger'):''}</div>`:''}</div>`).join('')}</div>`;
}
function hostLobby(){
  const count=state.target,joined=state.joined,pct=count?Math.round(joined/count*100):0;
  const minCount=Math.max(5,joined);
  return `${panel(`<div class="eyebrow">LIVE LOBBY</div>
  <div class="lobby-top"><div><div class="code">${esc(state.code)}</div>
  <p class="muted">${joined} of ${count} players joined</p>
  <div class="meter" role="progressbar" aria-valuenow="${joined}" aria-valuemax="${count}"><div style="width:${pct}%"></div></div></div>
  <div class="lobby-qr">${qrSvg(joinLink())}</div></div>
  <div class="row lobby-actions">${btn('COPY JOIN LINK','copy',{},'primary')}${btn('REFRESH','refresh',{},'ghost')}</div>
  <p class="help">Scan with the phone camera or enter the code. Every player must join from their own phone.</p>
  <details class="count-adjust"${countAdjustOpen?' open':''}><summary>Adjust player count</summary>
  <div class="stepper"><button class="secondary" data-action="count-step" data-data='{"delta":-1}' type="button" aria-label="Fewer players"${count<=minCount?' disabled':''}>−</button><b>${count}</b><button class="secondary" data-action="count-step" data-data='{"delta":1}' type="button" aria-label="More players"${count>=30?' disabled':''}>+</button></div>
  <p class="help">For when someone bails before dealing. Can't go below the players already in.</p></details>`)}
  <div class="grid">${panel(`<h2>PLAYERS (${joined}/${count})</h2><div class="roster">${state.players.map(p=>`<div class="person"><b>${esc(p.name)}</b>${btn('REMOVE','remove',{id:p.id},'small danger')}</div>`).join('')}</div>`)}
  ${panel(`<h2>BEFORE YOU START</h2><p class="help">Define physical Room A and Room B. Players will get randomly assigned after dealing. Nobody may communicate between rooms; no card trading.</p><p>First round: 3 min. Second: 2 min. Third: 1 min.</p><p><strong>${state.joined===count?'EVERYONE IS IN. READY TO DEAL.':`${count-state.joined} SEATS REMAIN.`}</strong></p>${btn('SHUFFLE & DEAL','start',{},'primary')}`)}</div>`;}
function hostTravel(){return panel(`<div class="eyebrow">DECK DEALT • ROOMS ASSIGNED</div><h1>PLAYERS, GO TO YOUR ROOMS</h1><p>When both physical groups are ready, begin the 3-minute first round.</p>${btn('BEGIN ROUND 1','begin',{},'primary')}`);}
function leaderName(room){return esc(person(state.leaders[room])?.name||'Not elected');}
function hostRoomPanel(room){const names=state.players.filter(p=>p.room===room&&!p.removed&&p.id!==state.leaders[room]);
  const canPick=state.phase==='LOCKING'&&!state.locked[room];const elected=!!state.leaders[room];
  const chosen=hostPicked[room];return `<div class="room ${room.toLowerCase()}"><div class="eyebrow">ROOM ${room}</div><p>Leader: <b>${leaderName(room)}</b></p><span class="pill ${state.locked[room]?'good':''}">${state.locked[room]?'HOSTAGES LOCKED':'NOT LOCKED'}</span>${canPick?`<p>Host recovery: choose exactly ${state.hostageCount} hostages.</p><div class="roster">${names.map(p=>`<button class="${chosen.has(p.id)?'selected':'secondary'}" data-action="host-toggle" data-data='${esc(JSON.stringify({room,id:p.id}))}'>${chosen.has(p.id)?'✓ ':''}${esc(p.name)}</button>`).join('')}</div><div class="spaced">${btn('LOCK HOST PICKS','host-pick',{room},'primary')}</div>`:''}<h3>Roster (${state.players.filter(p=>p.room===room).length})</h3>${nameList(room,true)}</div>`;
}
function hostGame(){let title=state.phase==='ROUND'?'ROUND IN PROGRESS':state.phase==='PAUSED'?'ROUND PAUSED':state.phase==='LOCKING'?'TIME UP · HOSTAGE LOCK':'HOSTAGE EXCHANGE';
  const active=['ROUND','PAUSED','LOCKING','EXCHANGE'].includes(state.phase);
  if(active)return `${panel(`<div class="row between"><div><div class="eyebrow">MISSION ${state.round} / 3 · LIVE CONTROL</div><h1>${title}</h1><p class="help">Hostages this round: ${state.hostageCount} from EACH room. Leader cannot be a hostage.</p></div><div class="center"><div class="timer" data-countdown>${timerText()}</div><div class="tag">${state.phase==='EXCHANGE'?'WAITING FOR PHYSICAL MOVEMENT':'HOST TIMER'}</div></div></div><div class="row">${state.phase==='ROUND'?`${btn('PAUSE','pause')}${btn('FORCE END ROUND','force-advance',{},'danger')}`:''}${state.phase==='PAUSED'?btn('RESUME','resume',{},'primary'):''}${state.phase==='EXCHANGE'?btn('CONFIRM EVERYONE MOVED · CONTINUE','advance',{},'primary'):''}${btn('SYNC SCREENS','refresh')}</div>${state.phase==='LOCKING'?`<p class="warn">Timer expired. Leader picks are closed. Select missing hostages below, or assign a missing leader first. No selections are visible until both rooms are locked.</p>`:''}${state.phase==='EXCHANGE'?`<p class="check">Both rooms locked. Confirm players have physically arrived before starting the next round. The timer will not restart without host confirmation.</p>`:''}`)}<div class="grid">${hostRoomPanel('A')}${hostRoomPanel('B')}</div>`;
  if(state.phase==='PREDICTION')return panel(`<h1>GAMBLER'S CALL</h1><p>Wait for the Gambler to lock their prediction privately. Do not reveal the teams yet.</p>${btn('CHECK GAMBLER STATUS','refresh')}`);
  if(state.phase==='FINAL_READY')return panel(`<h1>IT ALL COMES DOWN TO THIS.</h1><p>Final exchange complete. Gather players without mixing room identities. When everyone is ready, reveal simultaneously.</p>${btn('THE REVEAL','reveal',{},'primary')}`);
  if(state.phase==='REVEALED')return results();
  return panel('<p>Waiting for game state…</p>');
}
function results(){return `<section class="panel center"><div class="eyebrow">THE FINAL REVEAL · ALL CARDS DECLASSIFIED</div><div class="reveal-symbol">${state.result.winningTeam==='RED'?'✹':'✦'}</div><div class="result ${state.result.winningTeam==='RED'?'redtext':'bluetext'}">${state.result.winningTeam} TEAM WINS</div><h2>${state.result.winningTeam==='RED'?'THE BOMB WENT OFF.':'THE PRESIDENT SURVIVED.'}</h2><p>President: Room ${esc(state.result.presidentRoom)} · Bomber: Room ${esc(state.result.bomberRoom)}</p>${state.result.gambler?`<p>Gambler predicted ${esc(state.result.gambler.prediction)} — <b>${state.result.gambler.won?'GAMBLER ALSO WINS':'GAMBLER LOSES'}</b></p>`:''}</section><div class="grid">${['A','B'].map(r=>`<section class="room ${r.toLowerCase()}"><h2>FINAL ROOM ${r}</h2>${nameList(r)}</section>`).join('')}</div>`;}
function playerLobby(){return panel(`<div class="eyebrow">ROOM ${esc(state.code)}</div><h1>YOU'RE IN.</h1><h2>${esc(state.me.name)}</h2><p class="help">Waiting for the host. Keep this tab open; you can safely refresh and reclaim your seat.</p><div class="pill">${state.joined}/${state.target} players connected</div><div class="spaced">${btn('CHECK CONNECTION','refresh')}</div>`);}
function playerTravel(){return travelDismissed?`${panel(`<div class="eyebrow">YOUR STARTING ROOM</div><h1>ROOM ${esc(state.me.room)}</h1><p>Stay in your physical room until host starts.</p>`)}${cardElement()}`:`<section class="full ${state.me.room.toLowerCase()}"><div><div class="eyebrow">YOUR STARTING LOCATION</div><h1>GO TO</h1><div class="room-banner ${state.me.room.toLowerCase()}">ROOM ${esc(state.me.room)}</div><p>Move to the physical ${esc(state.me.room)} area now.</p><p class="help">The host will start the timer when both rooms are ready.</p>${btn('SHOW MY CARD','card-scroll',{},'primary')}</div></section>`;}
function cardElement(){return `<div class="panel"><div class="eyebrow">YOUR SECRET CARD</div><p class="help">Touch and HOLD to view. Release or switch apps to hide it. Only this phone receives your card.</p><div id="secret-card" class="card-back" role="button" tabindex="0" aria-label="Hold to reveal your own secret card"><div><span class="eyebrow">CLASSIFIED</span><h2>HOLD TO DECLASSIFY</h2><p>● ● ●</p></div></div></div>`;}
function cardFace(card){const title={PRESIDENT:'PRESIDENT',BOMBER:'BOMBER',RED:'RED TEAM',BLUE:'BLUE TEAM',GAMBLER:'GAMBLER'}[card]||'SECRET';
  return `<div class="card-label"><span class="subtitle">TWO ROOMS & A BOOM</span><span class="role-emblem">${card==='PRESIDENT'?'♛':card==='BOMBER'?'✹':card==='GAMBLER'?'◈':card==='RED'?'◆':'◇'}</span><span>${title}</span><span class="subtitle">${card==='PRESIDENT'?'STAY AWAY FROM THE BOMBER':card==='BOMBER'?'FIND THE PRESIDENT':card==='GAMBLER'?'PREDICT THE WINNER':'PROTECT YOUR TEAM'}</span></div>`;}
function peekCard(show){const elem=document.getElementById('secret-card');if(!elem||!state?.me?.card||state.phase==='REVEALED')return;
  peek=show;elem.className=show?`card-face ${state.me.card}`:'card-back';elem.innerHTML=show?cardFace(state.me.card):'<div><span class="eyebrow">CLASSIFIED</span><h2>HOLD TO DECLASSIFY</h2><p>● ● ●</p></div>';
}
document.addEventListener('pointerup',()=>peekCard(false));document.addEventListener('pointercancel',()=>peekCard(false));
document.addEventListener('visibilitychange',()=>{if(document.hidden)peekCard(false);else if(session&&!connected)connect();});window.addEventListener('blur',()=>peekCard(false));
function playerPolitics(){if(!state.me.room||state.phase!=='ROUND')return '';
 const r=state.me.room,leader=state.leaders[r],room=state.players.filter(p=>p.room===r&&!p.removed),me=state.me;
 const current=person(leader);const majority=Math.floor(room.length/2)+1;
 return panel(`<div class="eyebrow">LEADERSHIP & HOSTAGES</div><h2>${leader?`Leader: ${esc(current?.name||'Unknown')}`:'ELECT A LEADER'}</h2><p class="help">${leader?`Challenge a replacement with ${majority} votes for the same player. Anyone in the room may challenge, including themselves.`:'Tap another player to nominate the room’s first leader.'}</p>
 ${me.offer?`<div class="panel"><b>LEADERSHIP OFFER</b><p>Your leader wants to hand you the role.</p><div class="row">${btn('ACCEPT','accept',{},'primary')}${btn('DECLINE','decline')}</div></div>`:''}
 ${me.leader&&!me.locked?`<p class="check">YOU ARE THE LEADER. Choose ${state.hostageCount} hostage(s). You cannot nominate yourself.</p><div class="roster">${room.filter(p=>p.id!==me.id).map(p=>`<button class="${picked.has(p.id)?'selected':'secondary'}" data-action="pick-toggle" data-data='${esc(JSON.stringify({id:p.id}))}'>${picked.has(p.id)?'✓ ':''}${esc(p.name)}</button>`).join('')}</div><div class="spaced row">${btn(`LOCK ${state.hostageCount} HOSTAGE(S)`,'pick',{},'primary')}</div><p class="help">After locking, your choices are final and remain hidden from the other room.</p><h3>Prefer to be a hostage?</h3><p class="help">Offer the leadership to someone willing before locking.</p><div class="roster">${room.filter(p=>p.id!==me.id).map(p=>btn('OFFER TO '+p.name,'abdicate',{id:p.id},'small ghost')).join('')}</div>`:''}
 ${me.locked?'<p class="check">YOUR ROOM HOSTAGES ARE LOCKED. Waiting for the other room and the timer.</p>':''}
 ${!me.locked&&!(me.leader)?`<div class="roster">${room.filter(p=>leader?p.id!==leader:p.id!==me.id).map(p=>`<div class="person"><b>${esc(p.name)}</b>${btn(leader?'CHALLENGE':'NOMINATE',leader?'challenge':'nominate',{id:p.id},'small secondary')}</div>`).join('')}</div>`:''}
 ${leader?`<p class="help">Majority threshold: ${majority} of ${room.length}. ${Object.entries(state.voteCounts?.[r]||{}).map(([id,v])=>`${esc(person(id)?.name||'?')}: ${v}/${majority}`).join(' · ')}</p>`:''}</div>`);
}
function playerRound(){if(state.me.pendingMove)return `<section class="full ${state.me.room.toLowerCase()}"><div><div class="eyebrow">HOSTAGE EXCHANGE</div><h1>MOVE TO THE OTHER ROOM</h1><div class="room-banner ${state.me.room.toLowerCase()}">ROOM ${esc(state.me.room)}</div><p>Bring only your phone. Do not communicate between rooms during the move.</p>${btn("I'M IN THE ROOM",'ack-move',{},'primary')}</div></section>`;
  const phase=state.phase;const r=state.me.room;
  if(phase==='PREDICTION')return `${panel(`<h1>WAIT FOR THE GAMBLER</h1><p>No cards may be revealed yet.</p>${state.me.card==='GAMBLER'?(state.me.prediction?`<p class="check">YOUR PREDICTION: ${esc(state.me.prediction)} — LOCKED.</p>`:`<p>Predict which team won, based on where the President and Bomber ended up.</p><div class="row">${btn('RED TEAM WON','prediction',{team:'RED'},'danger')}${btn('BLUE TEAM WON','prediction',{team:'BLUE'},'primary')}</div>`):'<p>The Gambler is choosing privately. The host will reveal shortly.</p>'}`)}${cardElement()}`;
  if(phase==='FINAL_READY')return `${panel('<h1>GET READY FOR THE BIG REVEAL</h1><p>Keep your card secret. The host is about to flip all cards simultaneously.</p>')}${cardElement()}`;
  return `<div class="grid"><div>${panel(`<div class="eyebrow">ROUND ${state.round} / 3 · ROOM ${esc(r)}</div><div class="timer" data-countdown>${timerText()}</div><p>${phase==='ROUND'?'TALK. BLUFF. SURVIVE.':phase==='PAUSED'?'HOST PAUSED TIMER':phase==='LOCKING'?'TIME UP. WAIT FOR HOST.':'HOSTAGE EXCHANGE'}</p><span class="pill">${state.hostageCount} hostage(s) per room</span>`)}${cardElement()}</div><div>${panel(`<h2>YOUR ROOM: ${esc(r)}</h2><p class="help">No talking or signaling to Room ${r==='A'?'B':'A'}.</p><div class="roster">${state.players.filter(p=>p.room===r).map(p=>`<div class="person"><b>${esc(p.name)}</b>${state.leaders[r]===p.id?'<span class="tag">★ LEADER</span>':''}</div>`).join('')}</div>`)}${playerPolitics()}</div></div>`;
}
function playerReveal(){return `${results()}${panel(`<h2>YOUR CARD: ${esc(state.me.card)}</h2><div class="card-face ${esc(state.me.card)}">${cardFace(state.me.card)}</div>`)}`;}
function host(){return `<div class="shell">${header()}${state.phase==='LOBBY'?hostLobby():state.phase==='TRAVEL'?hostTravel():hostGame()}${footer()}</div>`;}
function player(){return `<div class="shell">${header()}${state.phase==='LOBBY'?playerLobby():state.phase==='TRAVEL'?playerTravel():state.phase==='REVEALED'?playerReveal():playerRound()}${footer()}</div>`;}
function render(){root.innerHTML=(!session?startPage():!state?`<div class="shell">${header()}${panel('<h2>CONNECTING TO YOUR ROOM…</h2><p>The connection status will appear if the backend is unreachable.</p>')}</div>`:session.role==='host'?host():player())+rulesOverlay();}
root.addEventListener('pointerdown',e=>{if(e.target.closest('#secret-card')){e.preventDefault();peekCard(true);}});
root.addEventListener('keydown',e=>{if(e.target.id==='secret-card'&&(e.key===' '||e.key==='Enter')){e.preventDefault();peekCard(true);}});
root.addEventListener('keyup',e=>{if(e.target.id==='secret-card')peekCard(false);if(e.key==='Escape'&&rulesOpen){rulesOpen=false;render();}});
root.addEventListener('toggle',e=>{if(e.target.classList&&e.target.classList.contains('count-adjust'))countAdjustOpen=e.target.open;},true);
root.addEventListener('submit',async e=>{
  e.preventDefault();if(waiting)return;
  // command() owns the busy flag. Pre-setting waiting would silently cancel this update.
  waiting=true;
  try{
    if(e.target.id==='create-form'){
      const count=Number(e.target.querySelector('#count').value),r=await request('/api/rooms',{playerCount:count});
      if(!store(keyHost,{role:'host',code:r.code,token:r.token}))notify('Storage blocked: host refresh cannot recover this room on this browser.');
      beginSession('host',r.code,r.token);
    }else if(e.target.id==='join-form'){
      const code=e.target.querySelector('#room-code').value.trim().toUpperCase(),name=e.target.querySelector('#player-name').value.trim();
      if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))throw new Error('Enter a valid 6-character room code.');
      const saved=read(seatPrefix+code);
      if(saved?.token){beginSession('player',code,saved.token);return;}
      const r=await request(`/api/rooms/${code}/join`,{name});
      if(!store(seatPrefix+code,{role:'player',code,token:r.token}))notify('Storage blocked: refreshing might lose your seat. Enable browser storage before playing.');
      history.replaceState(null,'','#join='+code);beginSession('player',code,r.token);
    }
  }catch(err){notify(err.message);offline(err.message);}finally{waiting=false;}
});
root.addEventListener('click',async e=>{
  const b=e.target.closest('[data-action]');if(!b)return;
  const action=b.dataset.action;let data={};try{data=JSON.parse(b.dataset.data||'{}');}catch{}
  if(action==='landing-tab'){landingTab=data.tab==='join'?'join':'host';render();return;}
  if(action==='count-step'){await command('set-count',{count:state.target+data.delta});return;}
  if(action==='rules-open'){rulesOpen=true;render();return;}
  if(action==='rules-x'){rulesOpen=false;render();return;}
  if(action==='rules-close'){if(e.target.closest('.rules-card'))return;rulesOpen=false;render();return;}
  if(action==='leave'){
    if(state&&state.phase!=='LOBBY'&&!window.confirm(session.role==='host'?'Leave this game? The room stays live — resume it any time from the landing page.':'Leave this game? Your seat stays reserved — rejoin from the link to reclaim it.'))return;
    stopConnection();session=null;state=null;rulesOpen=false;countAdjustOpen=false;picked=new Set();hostPicked={A:new Set(),B:new Set()};render();return;
  }
  if(action==='copy'){try{await navigator.clipboard.writeText(joinLink());notify('JOIN LINK COPIED');}catch{notify(joinLink());}return;}
  if(action==='refresh'){await refresh();return;}
  if(action==='restore-host'){const s=read(keyHost);if(s)beginSession('host',s.code,s.token);return;}
  if(action==='restore-player'){const s=read(seatPrefix+data.code);if(s)beginSession('player',s.code,s.token);return;}
  if(action==='card-scroll'){travelDismissed=true;render();return;}
  if(action==='pick-toggle'){if(picked.has(data.id))picked.delete(data.id);else if(picked.size<state.hostageCount)picked.add(data.id);render();return;}
  if(action==='host-toggle'){const chosen=hostPicked[data.room];if(chosen.has(data.id))chosen.delete(data.id);else if(chosen.size<state.hostageCount)chosen.add(data.id);render();return;}
  if(action==='pick'){if(picked.size!==state.hostageCount){notify(`Choose exactly ${state.hostageCount} hostages.`);return;}data.ids=[...picked];}
  if(action==='host-pick'){if(hostPicked[data.room].size!==state.hostageCount){notify(`Choose exactly ${state.hostageCount} hostages.`);return;}data.ids=[...hostPicked[data.room]];}
  if(['remove','force-advance','advance','reveal'].includes(action)){
    const m={remove:'Remove this player? After dealing, the seat remains reserved for game fairness.',
      'force-advance':'Force end this round now? Missing selections will need host intervention.',advance:'Confirm that all hostages reached their destination rooms? This will start the next round or final reveal preparation.',reveal:'Flip every card for every player right now?'};
    if(!window.confirm(m[action]))return;
  }
  await command(action,data);
});
window.addEventListener('hashchange',()=>{if(!session){if(codeFromHash())landingTab='join';render();}});
const joining=codeFromHash();const recovered=joining?read(seatPrefix+joining):(!joining?read(keyHost):null);
if(recovered?.token)beginSession(recovered.role,recovered.code,recovered.token);else render();
if(!configured)offline('This deployment has no configured realtime backend. Host and players cannot connect until it is configured.');
