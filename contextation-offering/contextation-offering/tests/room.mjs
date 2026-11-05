import assert from 'node:assert/strict';
import worker, { Room } from '../src/worker.js';
import { Room as RoomModel, MAX_ENTRIES } from '../src/room.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { PlaceSearch, distanceKm } from '../src/places.mjs';

// Synthetic test credentials and contributions only. No external requests.
const TEST_PASSWORD='Test-only-worker-room-42';
const ORIGIN='https://offering.contextation.com';
const LOCAL={label:'A test park',lat:43.041,lng:-76.132,kind:'place'};
const TOWN={label:'London',lat:51.5074,lng:-0.1278,kind:'town'};
let checks=0,clientNumber=0;
async function test(name,run){await run();checks++;console.log('PASS',name);}

function fixture(initial=[]) {
  const store=new Map(structuredClone(initial));
  let object,failWrite=false,initializations=0;
  const storage={
    get:async key=>structuredClone(store.get(key)),
    put:async(key,value)=>{
      if(failWrite){failWrite=false;throw new Error('Synthetic write failure');}
      for(const [name,item] of typeof key==='object'?Object.entries(key):[[key,value]]) store.set(name,structuredClone(item));
    },
    list:async({prefix=''}={})=>new Map([...store].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,structuredClone(value)])),
    delete:async keys=>Array.isArray(keys)?keys.reduce((count,key)=>count+Number(store.delete(key)),0):store.delete(keys),
    deleteAll:async()=>{throw new Error('A deployment must not delete the stored room');},
  };
  const restart=()=>{
    object=new Room({storage,blockConcurrencyWhile(callback){initializations++;return callback();}});
  };
  restart();
  const env={
    SITE_PASSWORD:TEST_PASSWORD,
    ASSETS:{fetch:async request=>new Response(new URL(request.url).pathname,{headers:{'Content-Type':'text/html'}})},
    ROOM:{
      idFromName:name=>{assert.equal(name,'class');return name;},
      get:id=>{assert.equal(id,'class');return {fetch:(url,init)=>object.fetch(new Request(url,init))};},
    },
  };
  return {env,store,restart,get initializations(){return initializations;},failNextWrite(){failWrite=true;},client:()=>new Client(env)};
}
class Client {
  constructor(env){this.env=env;this.cookies=new Map();this.address='test-client-'+(++clientNumber);}
  async request(path,{method='GET',body,rawBody,headers={},origin=ORIGIN}={}) {
    const requestHeaders={'CF-Connecting-IP':this.address,...headers};
    if(this.cookies.size) requestHeaders.Cookie=[...this.cookies].map(([key,value])=>key+'='+value).join('; ');
    if(!['GET','HEAD'].includes(method)&&origin!==null) requestHeaders.Origin=origin;
    if(body!==undefined) requestHeaders['Content-Type']='application/json';
    const request=new Request(ORIGIN+path,{method,headers:requestHeaders,body:body===undefined?rawBody:JSON.stringify(body)});
    const response=await worker.fetch(request,this.env);
    for(const cookie of response.headers.getSetCookie()) {
      const pair=cookie.split(';')[0],equal=pair.indexOf('=');
      if(pair.slice(equal+1)) this.cookies.set(pair.slice(0,equal),pair.slice(equal+1));
      else this.cookies.delete(pair.slice(0,equal));
    }
    const text=await response.text();
    return {status:response.status,headers:response.headers,text,data:response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(text):null};
  }
  async login(){
    const result=await this.request('/_gate/login',{method:'POST',rawBody:new URLSearchParams({password:TEST_PASSWORD,next:'/'}),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
    assert.equal(result.status,303);return result;
  }
  offer(round,place,displayName='',extra={}){return this.request('/api/contributions',{method:'POST',body:{round,place,displayName,...extra}});}
  control(action,extra={}){return this.request('/api/host/control',{method:'POST',body:{action,...extra}});}
}

await test('participant state is public, anonymous entries stay separate, and the complete collection requires the original gate',async()=>{
  const app=fixture(),alice=app.client(),bob=app.client(),host=app.client();
  const first=await alice.request('/api/state');
  assert.equal(first.status,200);assert.equal(first.data.phase,'local_open');
  assert.match(first.headers.get('set-cookie'),/^__Host-offering_participant=[a-f0-9]{48};/);
  for(const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/']) assert.ok(first.headers.get('set-cookie').includes(flag));
  assert.equal((await alice.offer('local',LOCAL,'Alice')).status,200);
  assert.equal((await bob.offer('local',{...LOCAL,label:'Another place'},'Bob')).status,200);
  const own=await alice.request('/api/state?host=1');
  assert.equal(own.data.counts.local,2);assert.equal(own.data.own.local.displayName,'Alice');
  assert.equal(own.data.entries,undefined);assert.ok(!own.text.includes('Bob'));assert.ok(!own.text.includes(TEST_PASSWORD));
  assert.equal((await host.request('/api/host/state')).status,401);
  assert.equal((await alice.control('open_hometown')).status,401);
  await host.login();
  assert.equal((await host.request('/api/session')).data.authenticated,true);
  const all=await host.request('/api/host/state');
  assert.deepEqual(all.data.entries.map(entry=>entry.displayName).sort(),['Alice','Bob']);
  assert.ok(!all.text.includes(alice.cookies.get('__Host-offering_participant')));
  assert.equal((await host.request('/_gate/logout',{method:'POST'})).status,303);
  assert.equal((await host.request('/api/host/state')).status,401);
});

await test('a restarted Durable Object restores the same room and contributions without modifying legacy storage',async()=>{
  const legacy={id:'legacy-id',phase:'local',place:'An older pin',lng:-76.13,lat:43.04};
  const app=fixture([['pin:legacy',legacy],['count',1]]),person=app.client();
  const first=await person.offer('local',LOCAL,'Someone');
  const session=first.data.state.sessionId,id=first.data.entry.id;
  app.restart();
  const restored=await person.request('/api/state');
  assert.equal(restored.status,200);assert.equal(restored.data.sessionId,session);
  assert.equal(restored.data.own.local.id,id);assert.equal(restored.data.counts.local,1);
  assert.equal(app.initializations,2);assert.deepEqual(app.store.get('pin:legacy'),legacy);assert.equal(app.store.get('count'),1);
  assert.equal(app.store.get('room:v2').version,2);
});

await test('simultaneous submissions are durable and do not overwrite other participants',async()=>{
  const app=fixture(),people=Array.from({length:20},()=>app.client()),host=app.client();
  const results=await Promise.all(people.map((person,index)=>person.offer('local',{...LOCAL,label:'Test place '+index},'Person '+index)));
  assert.ok(results.every(result=>result.status===200));
  app.restart();await host.login();
  const all=await host.request('/api/host/state');
  assert.equal(all.data.counts.local,20);assert.equal(new Set(all.data.entries.map(entry=>entry.id)).size,20);
});

await test('homes persist only their approximate point and generic label',async()=>{
  const app=fixture(),person=app.client();
  const result=await person.offer('local',{label:'123 Private Street',lat:43.041237,lng:-76.131943,kind:'home',address:'extra private detail'});
  assert.equal(result.status,200);
  assert.deepEqual(result.data.entry.place,{label:'A neighborhood',lat:43.04,lng:-76.13,kind:'home',approximate:true});
  const stored=JSON.stringify(app.store.get('room:v2'));
  for(const value of ['123 Private','43.041237','76.131943','extra private']) assert.ok(!stored.includes(value));
});

await test('place corrections and removal affect only the current browser',async()=>{
  const app=fixture(),person=app.client(),other=app.client();
  const first=await person.offer('local',LOCAL);
  const corrected=await person.offer('local',{...LOCAL,label:'Corrected label'});
  assert.equal(corrected.data.entry.id,first.data.entry.id);assert.equal(corrected.data.state.counts.local,1);
  await other.offer('local',LOCAL);
  assert.equal((await person.request('/api/contributions?round=local',{method:'DELETE'})).data.state.counts.local,1);
  assert.ok((await other.request('/api/state')).data.own.local);
  app.restart();assert.equal((await person.request('/api/state')).data.own.local,null);
});

await test('the two invitations, pause clock, and automatic rests survive object restarts',async()=>{
  const realNow=Date.now;let time=1800000000000;Date.now=()=>time;
  try {
    const app=fixture(),person=app.client(),host=app.client();await host.login();
    assert.equal((await person.request('/api/state')).data.serverTime,time);
    assert.equal((await host.control('start_local')).status,409);
    await person.offer('local',LOCAL);
    assert.equal((await host.control('start_local')).data.state.phase,'local_reveal');
    assert.equal((await person.offer('local',LOCAL)).status,409);
    time+=12000;
    const paused=await host.control('pause');
    assert.equal(paused.data.state.clock.elapsedMs,12000);assert.equal(paused.data.state.clock.paused,true);
    time+=90000;app.restart();
    assert.equal((await person.request('/api/state')).data.phase,'local_reveal');
    await host.control('resume');time+=38001;
    assert.equal((await person.request('/api/state')).data.phase,'local_rest');
    app.restart();assert.equal((await person.request('/api/state')).data.clock.elapsedMs,50000);
    assert.equal((await host.control('open_hometown')).data.state.phase,'hometown_open');
    assert.equal((await host.control('start_hometown')).status,409);
    await person.offer('hometown',TOWN);
    assert.equal((await person.request('/api/state')).data.phase,'hometown_open');
    assert.equal((await host.control('start_hometown')).data.state.phase,'hometown_reveal');
    time+=60001;
    assert.equal((await person.request('/api/state')).data.phase,'hometown_rest');
    assert.equal((await host.control('finish')).data.state.phase,'complete');
    app.restart();assert.equal((await person.request('/api/state')).data.phase,'complete');
  } finally {Date.now=realNow;}
});

await test('reset rotates the room and rejects stale submissions while retaining legacy pins',async()=>{
  const legacy={id:'legacy-test',place:'Older stored place'};
  const app=fixture([['pin:older',legacy],['count',1]]),person=app.client(),host=app.client();await host.login();
  const old=(await person.offer('local',LOCAL)).data.state.sessionId;
  const reset=await host.control('reset',{sessionId:old});
  assert.notEqual(reset.data.state.sessionId,old);assert.equal(reset.data.state.entries.length,0);
  const stale=await person.offer('local',LOCAL,'',{sessionId:old});
  assert.equal(stale.status,409);assert.equal(stale.data.code,'room_changed');
  app.restart();assert.equal((await person.request('/api/state')).data.counts.local,0);
  assert.deepEqual(app.store.get('pin:older'),legacy);assert.equal(app.store.get('count'),1);
});

await test('facilitator submissions need authentication and create distinct entries',async()=>{
  const app=fixture(),host=app.client();const body={round:'local',place:LOCAL,displayName:''};
  assert.equal((await host.request('/api/host/contributions',{method:'POST',body})).status,401);
  await host.login();
  const first=await host.request('/api/host/contributions',{method:'POST',body});
  const second=await host.request('/api/host/contributions',{method:'POST',body});
  assert.equal(first.status,200);assert.equal(second.data.state.counts.local,2);assert.notEqual(first.data.entry.id,second.data.entry.id);
});

await test('example seeding stays explicit and does not replace a populated room',async()=>{
  const app=fixture(),host=app.client();await host.login();
  const demo=await host.control('demo');
  assert.equal(demo.status,200);assert.equal(demo.data.state.demoMode,true);
  assert.equal(demo.data.state.counts.local,5);assert.equal(demo.data.state.counts.hometown,5);
  assert.ok(demo.data.state.entries.every(entry=>entry.isExample&&entry.displayName.startsWith('Example')));
  assert.equal((await host.control('demo')).status,409);
  app.restart();assert.equal((await host.request('/api/host/state')).data.demoMode,true);
});

await test('invalid locations, cross-origin requests, and oversized JSON cannot modify the room',async()=>{
  const app=fixture(),person=app.client();
  assert.equal((await person.offer('local',TOWN)).data.code,'outside_local_area');
  assert.equal((await person.offer('local',{...LOCAL,lat:'43.04'})).status,400);
  assert.equal((await person.offer('local',{...LOCAL,label:'x'.repeat(161)})).status,400);
  assert.equal((await person.offer('local',LOCAL,'x'.repeat(41))).status,400);
  const options={method:'POST',body:{round:'local',place:LOCAL}};
  assert.equal((await person.request('/api/contributions',{...options,origin:null})).status,403);
  assert.equal((await person.request('/api/contributions',{...options,origin:'https://other.example'})).status,403);
  assert.equal((await person.request('/api/contributions',{method:'POST',rawBody:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await person.request('/api/contributions',{method:'POST',rawBody:'{',headers:{'Content-Type':'application/json'}})).status,400);
  assert.equal((await person.request('/api/contributions',{method:'POST',body:{padding:'x'.repeat(9000)}})).status,413);
  assert.equal((await person.request('/api/state')).data.counts.local,0);
});

await test('a failed durable write returns an error and rolls back the in-memory edit',async()=>{
  const app=fixture(),person=app.client();await person.request('/api/state');
  app.failNextWrite();
  assert.equal((await person.offer('local',LOCAL)).status,503);
  assert.equal((await person.request('/api/state')).data.counts.local,0);
  app.restart();assert.equal((await person.request('/api/state')).data.counts.local,0);
  assert.equal((await person.offer('local',LOCAL)).status,200);
});

await test('the room has a durable capacity bound while existing entries remain correctable',async()=>{
  const model=new RoomModel(DEFAULT_CONFIG);
  for(let i=0;i<MAX_ENTRIES;i++) model.contribute('capacity-'+i,{round:'local',place:LOCAL});
  const before=model.entries.get('capacity-0').get('local').id;
  const edited=model.contribute('capacity-0',{round:'local',place:{...LOCAL,label:'Corrected at capacity'}});
  assert.equal(edited.id,before);assert.equal(model.counts().local,MAX_ENTRIES);
  assert.throws(()=>model.contribute('one-too-many',{round:'local',place:LOCAL}),error=>error.status===429&&error.code==='room_full');
});

await test('public modules, host alias, release marker, and bounded search are available without exposing credentials',async()=>{
  const app=fixture(),person=app.client(),host=app.client();
  for(const path of ['/join','/app.css','/client.js','/map.js','/map.css','/join.js']) assert.equal((await person.request(path)).status,200,path);
  for(const path of ['/','/host','/host.js']) assert.equal((await person.request(path)).status,303,path);
  const config=await person.request('/api/config');
  assert.equal(config.data.release,'bare-v2-2026-11-05');assert.ok(!config.text.includes(TEST_PASSWORD));
  const examples=await person.request('/api/search?source=examples&round=local');
  assert.equal(examples.data.source,'example-catalog');assert.ok(examples.data.results.every(place=>place.distanceKm<=64.3736));
  assert.equal((await person.request('/api/search?q='+('x'.repeat(121)))).status,400);
  assert.equal((await person.request('/api/search?round=unknown')).status,400);
  await host.login();
  const alias=await host.request('/host');assert.equal(alias.status,200);assert.equal(alias.text,'/');
  const csp=alias.headers.get('Content-Security-Policy');
  assert.match(csp,/script-src[^;]*https:\/\/unpkg\.com/);assert.match(csp,/connect-src[^;]*https:\/\/unpkg\.com/);
});

await test('live search filtering and offline fallback remain truthful with controlled provider responses',async()=>{
  let requested;
  const feature=(name,lat,lng)=>({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]},properties:{name,city:'Syracuse',osm_key:'leisure',osm_value:'park'}});
  const live=new PlaceSearch(DEFAULT_CONFIG,{fetchImpl:async url=>{
    requested=url;return Response.json({features:[feature('Willow Garden',43.043,-76.134),feature('Willow',43.1,-76.15),feature('Willow',43.1,-76.15),feature('Willow abroad',51.5,-.12)]});
  }});
  const result=await live.search('Willow','local');
  assert.deepEqual(result.results.map(place=>place.label),['Willow','Willow Garden']);
  assert.ok(result.results.every(place=>distanceKm(DEFAULT_CONFIG.center,place)<=DEFAULT_CONFIG.radiusKm));
  assert.equal(requested.origin,'https://photon.komoot.io');assert.ok(requested.searchParams.has('bbox'));
  const offline=new PlaceSearch(DEFAULT_CONFIG,{fetchImpl:async()=>{throw new Error('Synthetic offline provider');}});
  const fallback=await offline.search('Tokyo','hometown');
  assert.equal(fallback.source,'example-catalog');assert.match(fallback.notice,/unavailable/);assert.equal(fallback.results[0].label,'Tokyo');
});

await test('hometown search favors a town qualified by its state and excludes non-settlement localities',async()=>{
  const feature=(properties,lat=37.54,lng=-77.43)=>({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]},properties});
  let requested;
  const live=new PlaceSearch(DEFAULT_CONFIG,{fetchImpl:async url=>{
    requested=url;return Response.json({features:[
      feature({name:'Central Office District, Richmond, Virginia',type:'locality',osm_key:'landuse',osm_value:'commercial',city:'Richmond',state:'Virginia',country:'United States'}),
      feature({name:'New Richmond',type:'city',osm_key:'place',osm_value:'village',state:'West Virginia',country:'United States'},42,-76),
      feature({name:'Richmond Beach',type:'locality',osm_key:'place',osm_value:'neighbourhood',state:'Virginia',country:'United States'}),
      feature({name:'Richmond',type:'city',osm_key:'place',osm_value:'city',state:'Virginia',country:'United States'}),
      feature({name:'Richmond Marine Terminal',type:'locality',osm_key:'landuse',osm_value:'industrial',city:'Richmond',state:'Virginia',country:'United States'}),
    ]});
  }});
  assert.equal(live.timeoutMs,8000);
  const result=await live.search('Richmond, Virginia','hometown');
  assert.equal(result.source,'photon');
  assert.deepEqual(result.results.map(place=>place.label),['Richmond','New Richmond']);
  assert.deepEqual(requested.searchParams.getAll('layer'),['city','locality']);
});

console.log(`${checks} persistent room/API checks passed.`);
