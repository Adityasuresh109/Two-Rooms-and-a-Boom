"""Optional local Chromium smoke test (pip install playwright; Chromium must be installed).
This intercepts only test transport; it is NOT a real Cloudflare WebSocket load test.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parents[1]/'frontend'
players=[{'id':f'p{i}', 'name':f'Guest {i}', 'room':('A' if i<4 else 'B'),'removed':False} for i in range(7)]
requests=[]
views={
 'host': {'host':True,'code':'ABC234','target':6,'joined':5,'phase':'LOBBY','round':0,'until':None,'serverNow':1000,'timeLeft':None,'revision':1,'players':[dict(p) for p in players[:5]], 'leaders':{'A':None,'B':None},'locked':{'A':False,'B':False},'hostageCount':None,'voteCounts':{},'result':None},
 'player': {'host':False,'code':'ABC234','target':7,'joined':7,'phase':'ROUND','round':1,'until':2500000000000,'serverNow':1000,'timeLeft':None,'revision':1,'players':players[:4], 'leaders':{'A':'p1'},'locked':{'A':False},'hostageCount':1,'voteCounts':{'A':{}},'result':None,'me':{'id':'p0','name':'Guest 0','room':'A','card':'BOMBER','pendingMove':False,'promptNonce':0,'prediction':None,'leader':False,'locked':False,'vote':None}}
}
def serve(route):
 url=urlparse(route.request.url)
 if url.hostname=='localhost' and url.port==8711:
  f=(ROOT/(url.path.strip('/') or 'index.html'))
  if not f.is_file():return route.fulfill(status=404,body='not found')
  if f.name=='config.js':return route.fulfill(status=200,content_type='text/javascript',body="window.GAME_API_ORIGIN='http://localhost:8712';")
  media={'.js':'text/javascript','.html':'text/html','.css':'text/css'}
  return route.fulfill(status=200,content_type=media.get(f.suffix,'text/plain'),body=f.read_bytes())
 if url.hostname=='localhost' and url.port==8712:
  data=json.loads(route.request.post_data or '{}')
  if url.path=='/api/rooms': payload={'code':'ABC234','token':'host-secret'}
  elif url.path.endswith('/join'):payload={'token':'player-secret','id':'p0','code':'ABC234'}
  elif url.path.endswith('/state'):payload=views['host' if data.get('token')=='host-secret' else 'player']
  elif url.path.endswith('/action'):
   requests.append(data)
   payload={'ok':True,'revision':3}
  else:payload={'error':'unknown'}
  return route.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps(payload))
 return route.abort()
JS_WS="""
class TestSocket {
 static OPEN=1;
 constructor(url){this.url=url;this.readyState=0;this.listeners={};setTimeout(()=>{this.readyState=1;this.emit('open',{});},0);}
 addEventListener(event,handler){(this.listeners[event]??=[]).push(handler);}
 emit(e,x){for(const f of this.listeners[e]??[])f(x);}
 send(msg){const m=JSON.parse(msg);if(m.type==='hello')setTimeout(()=>{
 const view=m.token==='host-secret' ? window.__testHost : window.__testPlayer;
 this.emit('message',{data:JSON.stringify({type:'state',state:view})});},15);
 else if(m.type==='ping')this.emit('message',{data:JSON.stringify({type:'pong',serverNow:Date.now()})});}
 close(){this.readyState=3;this.emit('close',{});}
}
window.WebSocket=TestSocket;
"""
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 console=[]
 host=browser.new_context(viewport={'width':1200,'height':850});host.add_init_script(JS_WS+f'window.__testHost={json.dumps(views["host"])};window.__testPlayer={json.dumps(views["player"])};')
 host.route('**/*',serve)
 page=host.new_page();page.on('console',lambda m:console.append(m.type+': '+m.text) if m.type=='error' else None);page.on('pageerror',lambda err:console.append('PAGE ERROR: '+str(err)))
 page.goto('http://localhost:8711/');assert page.locator('.brand').inner_text()=='AD ARCADE';assert page.locator('.how-strip > div').count()==4
 assert page.locator('#create-form').is_visible();assert page.locator('#join-form').count()==0
 page.locator('#count').fill('6');page.get_by_role('button',name='CREATE GAME').click();page.locator('.qr svg rect').first.wait_for(timeout=10000)
 assert page.get_by_text('ABC234').count()>0
 assert page.locator('.qr svg rect').count()>50
 page.locator('.count-adjust summary').click()
 page.get_by_role('button',name='Fewer players').click()
 page.wait_for_timeout(150)
 assert any(x.get('action')=='set-count' and x.get('payload')=={'count':5} for x in requests),requests
 print('PASS stepper sends set-count (previously blocked by busy flag)')
 mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 mobile.add_init_script(JS_WS+f'window.__testHost={json.dumps(views["host"])};window.__testPlayer={json.dumps(views["player"])};')
 mobile.route('**/*',serve)
 pp=mobile.new_page();pp.on('console',lambda m:console.append(m.type+': '+m.text) if m.type=='error' else None);pp.on('pageerror',lambda err:console.append('PAGE ERROR: '+str(err)))
 pp.goto('http://localhost:8711/');pp.get_by_role('tab',name="I'M JOINING").click();pp.locator('#room-code').fill('ABC234');pp.locator('#player-name').fill('Guest 0');pp.get_by_role('button',name='JOIN ROOM').click()
 pp.locator('#secret-card').wait_for(timeout=10000);assert pp.url.endswith('#join=ABC234')
 assert 'HOLD TO DECLASSIFY' in pp.locator('#secret-card').inner_text()
 pp.locator('#secret-card').dispatch_event('pointerdown')
 assert 'BOMBER' in pp.locator('#secret-card').inner_text()
 pp.locator('#secret-card').dispatch_event('pointerup')
 assert 'HOLD TO DECLASSIFY' in pp.locator('#secret-card').inner_text()
 assert pp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'),'Mobile horizontal scrolling detected'
 pp.reload();pp.locator('#secret-card').wait_for(timeout=10000)
 assert 'Guest 0' in pp.locator('body').inner_text()
 deep=browser.new_context(viewport={'width':375,'height':812},is_mobile=True)
 deep.add_init_script(JS_WS+f'window.__testHost={json.dumps(views["host"])};window.__testPlayer={json.dumps(views["player"])};')
 deep.route('**/*',serve)
 dp=deep.new_page();dp.goto('http://localhost:8711/#join=ABC234')
 assert dp.locator('#join-form').is_visible();assert dp.locator('#room-code').input_value()=='ABC234'
 dp.get_by_role('tab',name="I'M HOSTING").click();assert dp.locator('#create-form').is_visible()
 # The backend-not-configured warning must remain present when config.js has no URL.
 def offline_config(route):
  if route.request.url.endswith('/config.js'):
   return route.fulfill(status=200,content_type='text/javascript',body="window.GAME_API_ORIGIN='';")
  return serve(route)
 offline=browser.new_context(viewport={'width':390,'height':844})
 offline.route('**/*',offline_config)
 op=offline.new_page();op.goto('http://localhost:8711/')
 assert op.get_by_text('Backend not configured.',exact=True).is_visible()
 assert not console,console
 print('CHROMIUM UI PASS: host QR, player join, peek and hide, refresh reclaim, zero console warnings/errors')
 browser.close()
