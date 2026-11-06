import assert from 'node:assert/strict';
import worker, { Room } from '../src/worker.js';
import { RelationalRoom } from '../src/relational-room.mjs';
import { RelationalPlaceSearch, formatRelationalPlace, tidyRelationalPlaces, signPlace, verifiedPlace } from '../src/relational-places.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { distanceKm } from '../src/places.mjs';

const ORIGIN='https://offering.contextation.com', PASSWORD='Synthetic-v2-password-42';
const PARK={label:'a test park',lat:43.04,lng:-76.13,kind:'place'};
const TOWN={label:'Tokyo',lat:35.6762,lng:139.6503,kind:'town'};
let checks=0;
async function test(name,run){await run();checks++;console.log('PASS',name);}
function fixture() {
  const stores=new Map(), objects=new Map(); let fail=false;
  const env={SITE_PASSWORD:PASSWORD,ASSETS:{fetch:async request=>new Response(new URL(request.url).pathname,{headers:{'Content-Type':'text/html'}})},ROOM:{
    idFromName:name=>name,
    get(name){
      if(!stores.has(name))stores.set(name,new Map());
      if(!objects.has(name)) {
        const store=stores.get(name);
        const storage={get:async key=>structuredClone(store.get(key)),put:async(key,value)=>{
          if(fail){fail=false;throw new Error('synthetic write failure');}
          for(const [k,v] of typeof key==='object'?Object.entries(key):[[key,value]])store.set(k,structuredClone(v));
        },list:async({prefix=''})=>new Map([...store].filter(([key])=>key.startsWith(prefix))),delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])store.delete(key);}};
        objects.set(name,new Room({storage,blockConcurrencyWhile:fn=>fn()}));
      }
      return {fetch:(url,init)=>objects.get(name).fetch(new Request(url,init))};
    },
  }};
  return {env,stores,restart(){objects.clear();},failNext(){fail=true;},client(){return new Client(env);}};
}
class Client {
  constructor(env){this.env=env;this.cookies=new Map();this.address=crypto.randomUUID();this.sessionId=null;}
  async call(path,method='GET',body,options={}) {
    const headers={'CF-Connecting-IP':this.address,...options.headers};
    if(this.cookies.size)headers.Cookie=[...this.cookies].map(([k,v])=>k+'='+v).join('; ');
    if(method!=='GET'&&method!=='HEAD')headers.Origin=options.origin??ORIGIN;
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await worker.fetch(new Request(ORIGIN+path,{method,headers,body:options.raw??(body===undefined?undefined:JSON.stringify(body))}),this.env);
    for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';');const i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}
    const value=await response.text(),data=response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(value):null;
    if(data?.sessionId)this.sessionId=data.sessionId;
    if(data?.state?.sessionId)this.sessionId=data.state.sessionId;
    return {status:response.status,data,text:value,headers:response.headers};
  }
  async state(){return this.call('/api/v2/state');}
  async login(){return this.call('/_gate/login','POST',undefined,{raw:new URLSearchParams({password:PASSWORD,next:'/v2'}),headers:{'Content-Type':'application/x-www-form-urlencoded'}});}
  join(displayName=''){return this.call('/api/v2/join','POST',{sessionId:this.sessionId,displayName});}
  offer(round,place,displayName){return this.call('/api/v2/contributions','POST',{sessionId:this.sessionId,round,place,...(displayName!==undefined?{displayName}:{})});}
  control(action,extra={}){return this.call('/api/v2/host/control','POST',{sessionId:this.sessionId,action,...extra});}
}

await test('v2 phone assets are public, the wall remains gated, and aerial CSP is scoped to v2 map pages',async()=>{
  const person=fixture().client();
  for(const path of ['/v2/join','/v2/join/','/v2/join.js','/v2/client.js','/v2/map.js','/v2/map-geo.js','/v2/map-land.json','/v2/map-aerial.js'])assert.equal((await person.call(path)).status,200,path);
  for(const path of ['/v2','/v2/','/v2/index.html','/v2/wall.js'])assert.equal((await person.call(path)).status,303,path);
  const join=await person.call('/v2/join');assert.equal(join.text,'/v2/join');
  assert.ok(join.headers.get('Content-Security-Policy').includes('https://orthos.its.ny.gov'));
  assert.ok(!(await person.call('/join')).headers.get('Content-Security-Policy').includes('orthos.its'));
  await person.login();const wall=await person.call('/v2');assert.equal(wall.text,'/v2/');
  assert.ok(!wall.headers.get('Content-Security-Policy').includes('unsafe-eval'));
});

await test('joining is deliberate, anonymous members remain distinct, and only the host receives other members',async()=>{
  const app=fixture(),a=app.client(),b=app.client(),host=app.client();
  assert.equal((await a.state()).data.counts.members,0);
  await b.state();await host.state();await host.login();
  const one=await a.join('Rowan'),two=await b.join('');
  assert.equal(one.status,200);assert.notEqual(one.data.member.id,two.data.member.id);
  assert.equal((await a.state()).data.members,undefined);
  assert.equal((await a.call('/api/v2/host/state')).status,401);
  const room=await host.call('/api/v2/host/state');assert.equal(room.data.members.length,2);
  assert.ok(!room.text.includes(a.cookies.get('__Host-offering_participant')));
  assert.equal(room.data.members.find(m=>m.id===two.data.member.id).displayName,'');
});

await test('one member connects two rounds; correction and removal preserve identity through restart',async()=>{
  const app=fixture(),a=app.client(),host=app.client();await a.state();await host.state();await host.login();
  const member=(await a.join('Ari')).data.member;
  const first=await a.offer('local',PARK);assert.equal(first.data.entry.memberId,member.id);
  const corrected=await a.offer('local',{...PARK,label:'a corrected place'});assert.equal(corrected.data.entry.id,first.data.entry.id);
  await a.join('');assert.equal((await a.state()).data.own.local.displayName,'');
  const removed=await a.call('/api/v2/contributions?round=local&sessionId='+a.sessionId,'DELETE');
  assert.equal(removed.data.state.member.id,member.id);assert.equal(removed.data.state.member.localEntryId,null);
  await a.offer('local',PARK);
  assert.equal((await a.offer('hometown',TOWN)).status,409);
  await host.control('open_hometown');await a.offer('hometown',TOWN);app.restart();
  const state=(await a.state()).data;
  assert.equal(state.own.local.memberId,state.own.hometown.memberId);
  assert.equal(state.member.hometownEntryId,state.own.hometown.id);
});

await test('v2 has a separate room and reset cannot clear or rewrite the original offering',async()=>{
  const app=fixture(),person=app.client(),host=app.client();
  const old=await person.call('/api/contributions','POST',{round:'local',place:PARK,displayName:'Original'});
  await person.state();await person.join('V2');await person.offer('local',PARK);
  await host.state();await host.login();const oldV2=host.sessionId;await host.control('reset');
  assert.equal((await person.call('/api/state')).data.own.local.id,old.data.entry.id);
  assert.equal((await person.state()).data.counts.members,0);
  const stale=await person.call('/api/v2/join','POST',{sessionId:oldV2,displayName:'stale'});assert.equal(stale.status,409);
  assert.deepEqual([...app.stores.keys()].sort(),['class','class-relational-v2']);
});

await test('provider metadata is signed; tampering cannot relabel a chosen point as verified search data',async()=>{
  const place={...PARK,label:'Recess Coffee',detail:'Syracuse, New York',source:'photon',precision:'point',osmId:'N123'};
  const signed=await signPlace(place,'local',ORIGIN,PASSWORD);
  const verified=await verifiedPlace({...signed,label:'invented',lat:1},'local',ORIGIN,PASSWORD);
  assert.equal(verified.label,place.label);assert.equal(verified.lat,place.lat);
  await assert.rejects(verifiedPlace(signed,'hometown',ORIGIN,PASSWORD),error=>error.code==='invalid_selection');
  await assert.rejects(verifiedPlace(signed,'local','https://other.example',PASSWORD),error=>error.code==='invalid_selection');
  const manual=await verifiedPlace({...place},'local',ORIGIN,PASSWORD);assert.equal(manual.source,'map');assert.equal(manual.osmId,undefined);
  const app=fixture(),person=app.client();await person.state();
  const stored=(await person.offer('local',signed)).data.entry.place;
  assert.equal(stored.detail,place.detail);assert.equal(stored.osmId,'N123');assert.equal(stored.selectionToken,undefined);
  const reviewed=(await person.offer('local',stored)).data.entry.place;
  assert.equal(reviewed.source,'photon');assert.equal(reviewed.osmId,'N123');
});

await test('homes are reduced to a 500 metre neighborhood cell before durable storage',async()=>{
  const app=fixture(),person=app.client();await person.state();
  const exact={label:'123 Private Lane',lat:43.041237,lng:-76.131943,kind:'home',detail:'private detail',source:'photon',osmId:'W456',precision:'address'};
  const result=await person.offer('local',await signPlace(exact,'local',ORIGIN,PASSWORD));
  assert.equal(result.status,200);assert.equal(result.data.entry.place.precision,'approximate');
  assert.ok(distanceKm(exact,result.data.entry.place)<.36);assert.notEqual(result.data.entry.place.lat,exact.lat);
  const stored=JSON.stringify([...app.stores.get('class-relational-v2')]);
  for(const value of ['123 Private','private detail','43.041237','76.131943','W456','selectionToken'])assert.ok(!stored.includes(value),value);
});

await test('search ranks actual names, deduplicates nearby records, rejects roads for place queries and never disguises fallback examples',async()=>{
  const base={geometry:{type:'Point',coordinates:[-76.13,43.04]}};
  assert.equal(formatRelationalPlace({...base,properties:{name:'Oswego Road',osm_key:'highway',osm_value:'residential'}},'oswego','local'),null);
  const home=formatRelationalPlace({...base,properties:{housenumber:'721',street:'University Avenue',type:'house'}},'721 university ave','local');assert.equal(home.kind,'home');
  const industrial=formatRelationalPlace({...base,properties:{name:'Industry',osm_key:'landuse',osm_value:'industrial',type:'locality'}},'industry','hometown');assert.equal(industrial,null);
  const places=[{...PARK,label:'Green Lakes Road'},{...PARK,label:'Green Lakes',lng:-75.9715},{...PARK,label:'Green Lakes',lng:-75.9714}];
  const results=tidyRelationalPlaces(places,'green lakes','local',DEFAULT_CONFIG);assert.equal(results[0].label,'Green Lakes');assert.equal(results.length,2);
  const failed=new RelationalPlaceSearch(DEFAULT_CONFIG,{fetchImpl:async()=>{throw new Error('offline');}});
  const search=await failed.search('Thornden','local');assert.deepEqual(search.results,[]);assert.equal(search.source,'unavailable');
});

await test('a seek holds the shared clock, survives restart, rejects invalid time, and finish reveals the whole hometown view',async()=>{
  let now=1800000000000;const room=new RelationalRoom(DEFAULT_CONFIG,{now:()=>now});
  room.join('a',{displayName:'A'});room.contribute('a',{round:'local',place:PARK});room.control('start_local');now+=7000;
  room.control('seek',{elapsedMs:24000});assert.equal(room.clock.paused,true);now+=60000;assert.equal(room.elapsed(),24000);
  const restored=new RelationalRoom(DEFAULT_CONFIG,{now:()=>now});restored.restore(room.snapshot());assert.equal(restored.elapsed(),24000);
  assert.throws(()=>restored.control('seek',{elapsedMs:-1}));assert.throws(()=>restored.control('seek',{elapsedMs:Infinity}));
  restored.control('resume');now+=1000;assert.equal(restored.elapsed(),25000);
  restored.control('open_hometown');assert.equal(restored.localProgressAtHandoff,.5);
  assert.equal(restored.snapshot().localProgressAtHandoff,.5);
  restored.contribute('a',{round:'hometown',place:TOWN});restored.control('start_hometown');
  restored.control('finish');assert.equal(restored.clock.elapsedMs,restored.clock.durationMs);assert.equal(restored.phase,'complete');
});

await test('simultaneous joins survive restart and a failed durable update does not leak into the room',async()=>{
  const app=fixture(),people=Array.from({length:12},()=>app.client()),host=app.client();
  await Promise.all(people.map(p=>p.state()));await Promise.all(people.map((p,i)=>p.join('Person '+i)));
  await Promise.all(people.map(p=>p.offer('local',PARK)));app.restart();await host.state();await host.login();
  const all=await host.call('/api/v2/host/state');assert.equal(all.data.members.length,12);assert.equal(all.data.entries.length,12);
  app.failNext();assert.equal((await people[0].join('should roll back')).status,503);
  assert.equal((await people[0].state()).data.member.displayName,'Person 0');
});

await test('host controls and assisted entries require login, origins and current room; examples never replace joined participants',async()=>{
  const app=fixture(),person=app.client(),host=app.client();await person.state();await host.state();
  assert.equal((await person.control('open_hometown')).status,401);
  assert.equal((await person.call('/api/v2/join','POST',{sessionId:person.sessionId},{origin:'https://other.example'})).status,403);
  await host.login();await person.join('One');assert.equal((await host.control('demo')).status,409);
  const member=(await person.state()).data.member;
  const added=await host.call('/api/v2/host/contributions','POST',{sessionId:host.sessionId,memberId:member.id,round:'local',place:PARK});
  assert.equal(added.status,200);assert.equal(added.data.entry.memberId,member.id);assert.equal(added.data.state.members.length,1);
});

console.log(`${checks} isolated v2 data, privacy, clock and authentication checks passed.`);
