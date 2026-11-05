import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../src/worker.js';

// Local-only test credentials, NOT a production password.
const password='T3stOnly!';
const origin='https://offering.contextation.com';
let assetCalls=0;
const env={SITE_PASSWORD:password,ASSETS:{fetch:async()=>{assetCalls++;return new Response('PRIVATE CONTENT',{headers:{'Content-Type':'text/plain','Cache-Control':'public,max-age=999','ETag':'cached'}});}}};
const req=(path='/',cookie='',options={})=>new Request(origin+path,{...options,headers:{...(cookie?{Cookie:cookie}:{}),...options.headers}});
const post=(path,values,headers={})=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Origin':origin,...headers},body:new URLSearchParams(values)});
const run=(request,bindings=env)=>worker.fetch(request,bindings);
let checks=0;
async function test(name,fn){await fn(); checks++; console.log('PASS',name);}

await test('missing or weak secrets fail closed',async()=>{
  for(const value of [undefined,'','short','12345678']){
    const before=assetCalls;
    const r=await run(req('/styles.css'),{...env,SITE_PASSWORD:value});
    assert.equal(r.status,503);assert.equal(assetCalls,before);
  }
});
await test('every anonymous path is protected',async()=>{
  for(const path of ['/','/index.html','/styles.css','/favicon.ico','/missing','/_worker.js']){
    const before=assetCalls;
    const r=await run(req(path));
    assert.equal(r.status,303);assert.ok(r.headers.get('location').startsWith('/_gate/login?'));assert.equal(assetCalls,before);
  }
});
await test('HEAD requests and conditional requests cannot bypass gate',async()=>{
  const before=assetCalls;
  const r=await run(req('/styles.css','',{method:'HEAD',headers:{'If-None-Match':'cached'}}));
  assert.equal(r.status,303);assert.equal(assetCalls,before);
});
await test('login form reveals no assets or secrets',async()=>{
  const r=await run(req('/_gate/login'));
  const html=await r.text();
  assert.equal(r.status,200);assert.match(html,/type="password"/);assert.ok(!html.includes(password));assert.ok(!html.includes('/styles.css'));assert.match(r.headers.get('content-security-policy'),/form-action 'self'/);
});
await test('incorrect password creates no session',async()=>{
  const r=await run(post('/_gate/login',{password:'wrong'}));
  assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);
});
let session;
await test('correct password issues a secure cookie',async()=>{
  const r=await run(post('/_gate/login',{password,next:'/'}));
  assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/');
  session=r.headers.get('set-cookie');
  for(const part of ['__Host-offering_session=','Secure','HttpOnly','SameSite=Strict','Path=/','Max-Age=604800']) assert.ok(session.includes(part));
});
const cookie=session.split(';')[0];
await test('session allows pages and assets without caching',async()=>{
  for(const path of ['/','/styles.css']){
    const r=await run(req(path,cookie));assert.equal(r.status,200);assert.equal(await r.text(),'PRIVATE CONTENT');assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('etag'),null);
  }
});
await test('forged, duplicate, and malformed cookies are denied',async()=>{
  for(const bad of [cookie.slice(0,-1)+(cookie.endsWith('0')?'1':'0'),'__Host-offering_session=x',cookie+'; '+cookie]) assert.equal((await run(req('/',bad))).status,303);
});
await test('session cannot be reused on another origin',async()=>{
  const r=await run(new Request('https://other.example.org/',{headers:{Cookie:cookie}}));
  assert.equal(r.status,303);
});
await test('password rotation invalidates old sessions',async()=>{
  assert.equal((await run(req('/',cookie),{...env,SITE_PASSWORD:'Another-test-only-passphrase-7642!'})).status,303);
});
await test('expired signed sessions are denied',async()=>{
  const expiry=Math.floor(Date.now()/1000)-1;
  const body=`v1.${expiry}.${'a'.repeat(32)}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`contextation-offering-session\\n${origin}\\n${body}`));
  const hex=[...new Uint8Array(sig)].map(v=>v.toString(16).padStart(2,'0')).join('');
  assert.equal((await run(req('/',`__Host-offering_session=${body}.${hex}`))).status,303);
});
await test('redirect destinations cannot leave the origin',async()=>{
  for(const next of ['https://evil.example/','//evil.example/','/\\evil.example','/_gate/login','/\r\nevil']){
    const r=await run(post('/_gate/login',{password,next}));assert.equal(r.headers.get('location'),'/');
  }
  const r=await run(post('/_gate/login',{password,next:'/styles.css?ok=1'}));assert.equal(r.headers.get('location'),'/styles.css?ok=1');
});
await test('login rejects cross-origin or missing Origin',async()=>{
  for(const Origin of ['https://bad.example','null','']) assert.equal((await run(post('/_gate/login',{password},{Origin}))).status,403);
});
await test('logout rejects cross-origin forms',async()=>{
  for(const Origin of ['https://bad.example','null','']) assert.equal((await run(post('/_gate/logout',{}, {Origin}))).status,403);
});
await test('oversized and wrong-format forms fail',async()=>{
  assert.equal((await run(post('/_gate/login',{password:'x'.repeat(9000)}))).status,400);
  assert.equal((await run(post('/_gate/login',{password},{'Content-Type':'application/json'}))).status,400);
});
await test('logout revokes browser session cookie',async()=>{
  const r=await run(post('/_gate/logout',{}));assert.equal(r.status,303);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
});
await test('source and deployment files remain blocked',async()=>{
  for(const path of ['/_worker.js','/_routes.json','/.env','/%5fworker.js','/src/worker.js','/wrangler.json','/package-lock.json','/tests/gate.mjs','/.git/config']) assert.equal((await run(req(path,cookie))).status,404);
});
await test('a static asset failure fails closed',async()=>{
  const r=await run(req('/',cookie),{...env,ASSETS:{fetch:async()=>{throw new Error('simulated test failure');}}});
  assert.equal(r.status,503);assert.match(r.headers.get('cache-control'),/no-store/);
});
await test('HTTP is redirected to HTTPS',async()=>{
  const r=await run(new Request('http://offering.contextation.com/'));assert.equal(r.status,308);assert.equal(r.headers.get('location'),origin+'/');
});
await test('Cloudflare Workers configuration gates assets and disables previews',async()=>{
  const config=JSON.parse(await readFile(new URL('../wrangler.json',import.meta.url),'utf8'));
  assert.equal(config.name,'contextation-offering');assert.equal(config.main,'src/worker.js');
  assert.equal(config.assets.directory,'./dist');assert.equal(config.assets.binding,'ASSETS');
  assert.equal(config.assets.run_worker_first,true);assert.equal(config.preview_urls,false);
  assert.equal(config.assets.not_found_handling,'none');assert.equal(config.vars?.SITE_PASSWORD,undefined);
  assert.deepEqual(config.routes,[{pattern:'offering.contextation.com',custom_domain:true}]);
});
await test('login and logout forms use appropriate referrer policy',async()=>{
  for(const path of ['/_gate/login','/_gate/logout']){
    const r=await run(req(path));assert.equal(r.status,200);assert.equal(r.headers.get('referrer-policy'),'same-origin');
  }
  const r=await run(req('/',cookie));assert.equal(r.headers.get('referrer-policy'),'no-referrer');
});
// ── the join page, the pins API and the room (added with the map pages) ──
import {Room} from '../src/worker.js';
function memoryRoom(){
  const store=new Map();
  const storage={
    get:async k=>store.get(k),
    put:async (k,v)=>{ if(typeof k==='object'){for(const [kk,vv] of Object.entries(k)) store.set(kk,vv);} else store.set(k,v); },
    list:async ({prefix=''}={})=>new Map([...store.entries()].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a<b?-1:a>b?1:0)),
    delete:async keys=>Array.isArray(keys)?keys.reduce((count,key)=>count+Number(store.delete(key)),0):store.delete(keys),
    deleteAll:async ()=>store.clear(),
  };
  const object=new Room({storage});
  return {idFromName:n=>n,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
}
const roomEnv={...env,ROOM:memoryRoom()};
const postJSON=(path,body,headers={})=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,...headers},body:JSON.stringify(body)});
await test('join page and its files are open without a session',async()=>{
  for(const path of ['/join','/join.js','/join.css']){
    const before=assetCalls;
    const r=await run(req(path));
    assert.equal(r.status,200);assert.equal(assetCalls,before+1);assert.match(r.headers.get('cache-control'),/no-store/);
  }
  assert.match((await run(req('/join'))).headers.get('content-security-policy'),/tiles\.openfreemap\.org/);
  assert.doesNotMatch((await run(req('/join.js'))).headers.get('content-security-policy'),/openfreemap/);
  assert.equal((await run(req('/join','',{method:'POST'}))).status,405);
});
await test('the wall page gets the map policy only once signed in',async()=>{
  assert.equal((await run(req('/'))).status,303);
  assert.match((await run(req('/',cookie))).headers.get('content-security-policy'),/cdnjs\.cloudflare\.com/);
  assert.doesNotMatch((await run(req('/styles.css',cookie))).headers.get('content-security-policy'),/cdnjs/);
});
await test('phones can add a pin; junk is refused',async()=>{
  const ok=await run(postJSON('/api/pin',{phase:'local',place:'Thornden Park',who:'sample',kind:'park',lng:-76.1264,lat:43.0419,pid:'abcdef1234'}),roomEnv);
  assert.equal(ok.status,200);assert.equal((await ok.json()).ok,true);
  for(const bad of [{phase:'x',lng:0,lat:0},{phase:'local',lng:999,lat:0},{phase:'local',lng:'a',lat:'b'},null,'text']){
    assert.equal((await run(postJSON('/api/pin',bad),roomEnv)).status,400);
  }
  assert.equal((await run(postJSON('/api/pin',{phase:'local',lng:0,lat:0},{Origin:'https://bad.example'}),roomEnv)).status,403);
  const long=await run(postJSON('/api/pin',{phase:'home',place:'x'.repeat(500),who:'y'.repeat(500),lng:1,lat:2}),roomEnv);
  assert.equal(long.status,200);
});
await test('only the wall can read or clear the room',async()=>{
  assert.equal((await run(req('/api/pins'),roomEnv)).status,401);
  assert.equal((await run(postJSON('/api/clear',{})) ).status,401);
  const list=await run(req('/api/pins',cookie),roomEnv);
  assert.equal(list.status,200);
  const {pins}=await list.json();
  assert.equal(pins.length,2);assert.equal(pins[0].place,'Thornden Park');assert.equal(pins[0].kind,'park');assert.equal(pins[1].kind,'hometown');
  assert.equal(pins[1].place.length,80);assert.equal(pins[1].who.length,40);
  const cleared=await run(new Request(origin+'/api/clear',{method:'POST',headers:{Cookie:cookie,Origin:origin}}),roomEnv);
  assert.equal(cleared.status,200);
  assert.equal((await (await run(req('/api/pins',cookie),roomEnv)).json()).pins.length,0);
});
await test('an api without the room fails closed',async()=>{
  assert.equal((await run(postJSON('/api/pin',{phase:'local',lng:1,lat:2}))).status,503);
});
console.log(`${checks} offering authentication/deployment checks passed.`);
