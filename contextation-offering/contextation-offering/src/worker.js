// A small, password-protected Cloudflare Worker, adapted from viiibrant-hair.
// Configure SITE_PASSWORD as an encrypted Cloudflare runtime SECRET, never as a var.
// IMPORTANT: assets.run_worker_first must remain true to protect all static assets.

import { Room as RoomModel } from './room.mjs';
import { RelationalRoom } from './relational-room.mjs';
import { RelationalPlaceSearch, signPlace, verifiedPlace } from './relational-places.mjs';
import { DEFAULT_CONFIG, validateConfig } from './config.mjs';
import { PlaceSearch, examplePlaces } from './places.mjs';
import { HttpError } from './errors.mjs';

const COOKIE = '__Host-offering_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN = '/_gate/login';
const LOGOUT = '/_gate/logout';
const encoder = new TextEncoder();
const CONFIG = { ...validateConfig(DEFAULT_CONFIG), release: 'bare-v2-2026-11-05' };
const PARTICIPANT_COOKIE = '__Host-offering_participant';
const PARTICIPANT_SECONDS = 24 * 60 * 60;
const ROOM_STATE_KEY = 'room:v2';
const RELATIONAL_STATE_KEY = 'room:relational:v1';
const RELATIONAL_CONFIG = {
  ...CONFIG, release: 'relational-v2-2026-11-06',
  imagery: {
    enabled: true, name: 'NYS aerial', attribution: 'NYS ITS Geospatial Services',
    yearLabel: 'NYS imagery · 2022–2025',
    tileUrl: 'https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image',
    maxZoom: 19, bounds: [-76.93, 42.46, -75.34, 43.63],
  },
};
const BODY_LIMIT = 8192;

// The join page (what classmates open on their phones) and the API it needs are open;
// the wall at / and everything else stay behind the password.
const PUBLIC = new Set(['/join', '/join/', '/join.html', '/join.js', '/join.css', '/app.css', '/client.js', '/map.js', '/map.css', '/map2d.js', '/map2d.css', '/vector-basemap.js', '/vendor/leaflet.js', '/vendor/leaflet.css', '/vendor/vector-map.js', '/vendor/ol.css']);
for (const path of ['/v2/join', '/v2/join/', '/v2/join.html', '/v2/join.js', '/v2/join.css', '/v2/client.js', '/v2/map.js', '/v2/map.css', '/v2/map-land.json', '/v2/map-geo.js', '/v2/map-geo.LICENSE', '/v2/map-aerial.js']) PUBLIC.add(path);
// Pages that draw a map need the map library, its tiles, and the fonts; nothing else is loosened.
const MAP_PAGES = new Set(['/', '/index.html', '/host', '/host/', '/host.html', '/join', '/join/', '/join.html']);
const RELATIONAL_MAP_PAGES = new Set(['/v2', '/v2/', '/v2/index.html', '/v2/join', '/v2/join/', '/v2/join.html']);
const MAP_CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org https://unpkg.com; worker-src 'self' blob:; child-src blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const RELATIONAL_MAP_CSP = MAP_CSP.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: https://orthos.its.ny.gov").replace("connect-src 'self'", "connect-src 'self' https://orthos.its.ny.gov");
const KINDS = new Set(['home', 'food', 'coffee', 'park']);
const MAX_PINS = 400;
const SOURCE_FILES = /^\/(?:_worker\.js|_routes\.json|_headers|wrangler\.(?:jsonc?|toml)|package(?:-lock)?\.json|src|tests|\.git|\.dev\.vars|\.env)(?:\/|$)/i;

// Small, bounded per-isolate guards. Durable room capacity is enforced separately.
class RateLimit {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.entries = new Map(); }
  check(key) {
    const item = this.entries.get(key);
    return !item || item.until <= Date.now() || item.count < this.limit;
  }
  hit(key) {
    const item = this.entries.get(key);
    if (item && item.until > Date.now()) item.count += 1;
    else {
      if (this.entries.size >= 2000) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(key, { count: 1, until: Date.now() + this.windowMs });
    }
  }
  clear(key) { this.entries.delete(key); }
}
const failedLogins = new RateLimit(8, 300000);
const participantSearches = new RateLimit(40, 60000);
const upstreamSearches = new RateLimit(120, 60000);
const submissions = new RateLimit(30, 60000);
const search = new PlaceSearch(CONFIG, { fetchImpl: (...args) => fetch(...args) });
const relationalSearch = new RelationalPlaceSearch(RELATIONAL_CONFIG, { fetchImpl: (...args) => fetch(...args) });

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': 'DENY',
  'Vary': 'Cookie',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
function response(body, status = 200, extra = {}) {
  return new Response(body, {status, headers: {...BASE_HEADERS, ...extra}});
}
function redirect(location, cookie) {
  return response(null, 303, {Location: location, ...(cookie ? {'Set-Cookie': cookie} : {})});
}
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function safeNext(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname.startsWith('/_gate')) return '/';
    return url.pathname + url.search;
  } catch {return '/';}
}
function page(title, content, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f7f4fb"><title>${escapeHTML(title)}</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;background:#f7f4fb;color:#5e4d6e;display:grid;place-items:center;padding:28px;font:17px/1.55 ui-rounded,"SF Pro Rounded",Nunito,system-ui,sans-serif}main{width:min(100%,380px)}.dot{width:14px;height:14px;border-radius:50%;background:#b9a6f2;box-shadow:0 0 0 10px #e5dcff80;margin:6px 0 34px}h1{font-size:28px;font-weight:600;letter-spacing:-.01em;margin:0 0 10px}p{margin:0 0 18px;color:#8b7a9c}label{display:block;font-weight:600;margin:18px 0 8px}input{width:100%;font:inherit;color:#5e4d6e;border:1px solid #e3dced;border-radius:14px;padding:13px 15px;background:#fff;min-height:50px}input:focus-visible,button:focus-visible{outline:3px solid #d9c9ff;outline-offset:3px}button{width:100%;margin-top:16px;background:#e5dcff;color:#5e4d6e;border:0;border-radius:999px;min-height:50px;padding:12px 16px;cursor:pointer;font:600 17px/1.3 inherit}button:hover{background:#d9c9ff}.error{color:#c2567e;font-weight:600}code{font-size:.9em}
  </style></head><body><main><div class="dot" aria-hidden="true"></div>${content}</main></body></html>`;
  return response(html, status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Browser-native POST forms must send Origin; same-origin referrer policy supports that.
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
}
function loginPage(next, error = '', status = 200) {
  const joinPath = next.startsWith('/v2') ? '/v2/join' : '/join';
  return page('the wall', `<h1>the wall</h1><p>This screen is for the room. Phones go to <code>${joinPath}</code>.</p>${error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : ''}<form method="post" action="${LOGIN}"><input type="hidden" name="next" value="${escapeHTML(next)}"><label for="password">password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="256"><button type="submit">open</button></form>`, status);
}
function setupPage() {
  return page('not open yet', `<h1>not open yet</h1><p>The owner needs to set the encrypted <code>SITE_PASSWORD</code> secret in Cloudflare and deploy again.</p>`, 503);
}
function bytesToHex(bytes) {return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');}
function hexToBytes(hex) {return new Uint8Array(hex.match(/../g).map(n => parseInt(n, 16)));}
async function signingKey(password) {
  return crypto.subtle.importKey('raw', encoder.encode(password), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
async function equalPassword(provided, expected) {
  // Compare equal-length digests without logging or storing the entered password.
  const [a,b] = await Promise.all([provided,expected].map(v => crypto.subtle.digest('SHA-256',encoder.encode(v))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference=0;
  for (let i=0;i<left.length;i++) difference |= left[i]^right[i];
  return difference===0;
}
function signaturePayload(tokenBody, origin) {
  return encoder.encode(`contextation-offering-session\n${origin}\n${tokenBody}`);
}
async function newSession(password, origin) {
  const expiry=Math.floor(Date.now()/1000)+SESSION_SECONDS;
  const nonce=bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const body=`v1.${expiry}.${nonce}`;
  const signature=await crypto.subtle.sign('HMAC',await signingKey(password),signaturePayload(body,origin));
  return `${body}.${bytesToHex(signature)}`;
}
async function validSession(request,password) {
  const matches=(request.headers.get('Cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
  if(matches.length!==1) return false;
  const token=matches[0].slice(COOKIE.length+1);
  const match=/^(v1\.(\d{10})\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
  if(!match) return false;
  const expiry=Number(match[2]), now=Math.floor(Date.now()/1000);
  if(expiry<=now || expiry>now+SESSION_SECONDS) return false;
  return crypto.subtle.verify('HMAC',await signingKey(password),hexToBytes(match[3]),signaturePayload(match[1],new URL(request.url).origin));
}
function sessionCookie(token,maxAge=SESSION_SECONDS) {
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
async function readForm(request) {
  if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  if(Number(request.headers.get('Content-Length'))>8192) return null;
  const reader=request.body?.getReader(); if(!reader) return null;
  let total=0; const chunks=[];
  while(true) {
    const {value,done}=await reader.read(); if(done) break;
    total+=value.byteLength;
    if(total>8192) {await reader.cancel(); return null;}
    chunks.push(value);
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new URLSearchParams(new TextDecoder().decode(bytes));
}
async function handle(request,env) {
  const url=new URL(request.url);
  if(url.protocol!=='https:') return response(null,308,{Location:`https://${url.host}${url.pathname}${url.search}`});
  const password=env.SITE_PASSWORD;
if(typeof password!=='string' || password.length<9 || password.length>256) return setupPage();
  if(url.pathname.startsWith('/api/v2/')) return relationalApi(request,env,url,password);
  if(url.pathname.startsWith('/api/')) return api(request,env,url,password);
  if(PUBLIC.has(url.pathname)) {
    if(request.method!=='GET' && request.method!=='HEAD') return response('Method not allowed.',405,{Allow:'GET, HEAD'});
    return serveAsset(request,env,url);
  }
  if(url.pathname===LOGIN && request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin) return response('This request could not be accepted.',403);
    const address=request.headers.get('CF-Connecting-IP')||'unknown';
    if(!failedLogins.check(address)) return page('please wait','<h1>please wait</h1><p>Too many sign-in attempts. Try again in a few minutes.</p>',429);
    const form=await readForm(request);
    if(!form || form.getAll('password').length!==1) return response('Invalid form.',400);
    const next=safeNext(form.get('next'),url.origin);
    const submitted=form.get('password');
    if(submitted.length>256 || !(await equalPassword(submitted,password))) {
      failedLogins.hit(address);
      return loginPage(next,'That password did not match. Please try again.',401);
    }
    failedLogins.clear(address);
    return redirect(next,sessionCookie(await newSession(password,url.origin)));
  }
  if(url.pathname===LOGOUT) {
    if(request.method==='POST') {
      if(request.headers.get('Origin')!==url.origin) return response('This request could not be accepted.',403);
      return redirect(LOGIN,sessionCookie('',0));
    }
    if(request.method==='GET') return page('sign out','<h1>leave the wall?</h1><p>This browser will need the password again.</p><form method="post" action="/_gate/logout"><button type="submit">sign out</button></form>');
    return response('Method not allowed.',405,{Allow:'GET, POST'});
  }
  if(request.method!=='GET' && request.method!=='HEAD') return response('Method not allowed.',405,{Allow:'GET, HEAD'});
  if(url.pathname===LOGIN) return loginPage(safeNext(url.searchParams.get('next'),url.origin));
  if(!(await validSession(request,password))) return redirect(`${LOGIN}?next=${encodeURIComponent(safeNext(url.pathname+url.search,url.origin))}`);
  return serveAsset(request,env,url);
}
async function serveAsset(request,env,url) {
  // Safeguard against serving deployment source files, even if accidentally copied into dist.
  if(SOURCE_FILES.test(decodeURIComponent(url.pathname))) return response('Not found.',404);
  let assetRequest=request;
  if(['/host','/host/','/host.html'].includes(url.pathname)) assetRequest=new Request(new URL('/',url),request);
  else if(url.pathname==='/join/') assetRequest=new Request(new URL('/join',url),request);
  else if(['/v2','/v2/'].includes(url.pathname)) assetRequest=new Request(new URL('/v2/',url),request);
  else if(['/v2/join','/v2/join/'].includes(url.pathname)) assetRequest=new Request(new URL('/v2/join',url),request);
  const asset=await env.ASSETS.fetch(assetRequest);
  const headers=new Headers(asset.headers);
  for(const [name,value] of Object.entries(BASE_HEADERS)) headers.set(name,value);
  if(MAP_PAGES.has(url.pathname)) {
    headers.set('Content-Security-Policy',MAP_CSP);
  }
  if(RELATIONAL_MAP_PAGES.has(url.pathname)) headers.set('Content-Security-Policy',RELATIONAL_MAP_CSP);
  headers.delete('ETag');headers.delete('Last-Modified');
  return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
}

/* One persistent room. Public clients receive only their own contribution. */

function json(data,status=200,extra={}) {
  return response(JSON.stringify(data),status,{'Content-Type':'application/json; charset=utf-8',...extra});
}
function room(env) {
  return env.ROOM.get(env.ROOM.idFromName('class'));
}
function cookieValue(request,name) {
  const matches=(request.headers.get('Cookie')||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(name+'='));
  return matches.length===1 ? matches[0].slice(name.length+1) : '';
}
function participant(request) {
  let id=cookieValue(request,PARTICIPANT_COOKIE);
  if(/^[a-f0-9]{48}$/.test(id)) return {id,cookie:null};
  id=bytesToHex(crypto.getRandomValues(new Uint8Array(24)));
  return {id,cookie:`${PARTICIPANT_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${PARTICIPANT_SECONDS}`};
}
async function readJSON(request,limit=BODY_LIMIT) {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')) {
    throw new HttpError(415,'Send this request as JSON.','invalid_content_type');
  }
  if(Number(request.headers.get('Content-Length'))>limit) throw new HttpError(413,'That request is too large.','body_too_large');
  const reader=request.body?.getReader();
  if(!reader) throw new HttpError(400,'That request could not be read.','invalid_json');
  let total=0;const chunks=[];
  while(true) {
    const {done,value}=await reader.read();if(done) break;
    total+=value.byteLength;
    if(total>limit) {await reader.cancel();throw new HttpError(413,'That request is too large.','body_too_large');}
    chunks.push(value);
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try {
    const payload=JSON.parse(new TextDecoder().decode(bytes));
    if(!payload||typeof payload!=='object'||Array.isArray(payload)) throw new Error('Invalid object');
    return payload;
  } catch {throw new HttpError(400,'That request could not be read.','invalid_json');}
}
function cleanText(value,max) {
  return typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max) : '';
}
// The v1 APIs remain readable during the transition. They use separate keys.
function validPin(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)) return null;
  const phase=body.phase==='home'?'home':body.phase==='local'?'local':null;
  const lng=Number(body.lng),lat=Number(body.lat);
  if(!phase||!Number.isFinite(lng)||!Number.isFinite(lat)||Math.abs(lng)>180||Math.abs(lat)>85) return null;
  const place=cleanText(body.place,80)||'a place';
  const who=cleanText(body.who,40);
  const kind=phase==='home'?'hometown':KINDS.has(body.kind)?body.kind:'home';
  const pid=typeof body.pid==='string'&&/^[a-f0-9]{8,32}$/.test(body.pid)?body.pid:'';
  return {phase,place,who,kind,lng:Math.round(lng*1e5)/1e5,lat:Math.round(lat*1e5)/1e5,pid};
}
function legacyKind(name) {
  if(/cafe|café|coffee|tea|bakery/i.test(name)) return 'coffee';
  if(/park|lake|garden|wood|beach|trail/i.test(name)) return 'park';
  if(/restaurant|pizza|food|bar|pub|market|diner/i.test(name)) return 'food';
  return 'home';
}
async function searchPlaces(url,id,legacy=false) {
  const query=(url.searchParams.get('q')||'').trim();
  const round=legacy?(url.searchParams.get('local')==='1'?'local':'hometown'):(url.searchParams.get('round')||'local');
  const source=legacy?null:url.searchParams.get('source');
  if(!['local','hometown'].includes(round)) throw new HttpError(400,'Choose a valid round.','invalid_round');
  if(query.length>120) throw new HttpError(400,'Please use a shorter place search.','invalid_search');
  if((legacy&&query.length<2)||(query.length===1&&source!=='examples')) {
    return {results:[],source:'photon',notice:'Type at least two characters to search.'};
  }
  let result;
  if(source==='examples'||!query) result=await search.search(query,round,'examples');
  else {
    if(!participantSearches.check(id)) throw new HttpError(429,'Please pause briefly before searching again.','search_rate_limited');
    participantSearches.hit(id);
    if(!upstreamSearches.check('room')) {
      result={results:examplePlaces(query,round,CONFIG),source:'example-catalog',notice:'Live search is taking a short pause. These are matching example places.'};
    } else {
      upstreamSearches.hit('room');
      result=await search.search(query,round,source);
    }
  }
  if(!legacy) return result;
  // Older clients cannot label catalog fallbacks, so do not send them examples.
  if(result.source!=='photon') throw new HttpError(502,'Place search is unavailable. Please try again.','search_unavailable');
  return {results:result.results.map(place=>({name:place.label,label:place.detail||'',kind:legacyKind(place.label),lng:place.lng,lat:place.lat}))};
}
async function api(request,env,url,password) {
  let identity=null;
  const reply=(data,status=200)=>json(data,status,identity?.cookie?{'Set-Cookie':identity.cookie}:{});
  const forward=async(action,payload)=>{
    const result=await room(env).fetch(`https://room/v2/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
    });
    return reply(await result.json(),result.status);
  };
  try {
    const path=url.pathname;
    if(['POST','PUT','PATCH','DELETE'].includes(request.method)&&request.headers.get('Origin')!==url.origin) {
      throw new HttpError(403,'This request could not be accepted.','origin_mismatch');
    }
    if(path==='/api/config'&&request.method==='GET') return reply(CONFIG);
    if(path==='/api/session'&&request.method==='GET') return reply({authenticated:await validSession(request,password)});
    if(path==='/api/state'&&request.method==='GET') {
      identity=participant(request);
      return await forward('state',{participantId:identity.id,host:false});
    }
    if((path==='/api/search'||path==='/api/geocode')&&request.method==='GET') {
      identity=participant(request);
      return reply(await searchPlaces(url,identity.id,path==='/api/geocode'));
    }
    if(path==='/api/contributions'&&request.method==='POST') {
      const payload=await readJSON(request);identity=participant(request);
      if(!submissions.check(identity.id)) throw new HttpError(429,'Please pause briefly before sharing again.','submit_rate_limited');
      submissions.hit(identity.id);
      return await forward('contribute',{participantId:identity.id,payload});
    }
    if(path==='/api/contributions'&&request.method==='DELETE') {
      identity=participant(request);
      return await forward('remove',{participantId:identity.id,payload:{round:url.searchParams.get('round'),sessionId:url.searchParams.get('sessionId')||undefined}});
    }
    if(path==='/api/pin'&&request.method==='POST') {
      const pin=validPin(await readJSON(request,4096));
      if(!pin) throw new HttpError(400,'That pin could not be read.','invalid_pin');
      identity=participant(request);
      if(!submissions.check(identity.id)) throw new HttpError(429,'Please pause briefly before sharing again.','submit_rate_limited');
      submissions.hit(identity.id);
      const result=await room(env).fetch('https://room/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pin)});
      return reply(await result.json(),result.status);
    }
    if(!(await validSession(request,password))) throw new HttpError(401,'Sign in to the presenter view first.','host_required');
    if(path==='/api/host/state'&&request.method==='GET') {
      identity=participant(request);
      return await forward('state',{participantId:identity.id,host:true});
    }
    if(path==='/api/host/control'&&request.method==='POST') {
      const payload=await readJSON(request);identity=participant(request);
      return await forward('control',{participantId:identity.id,payload});
    }
    if(path==='/api/host/contributions'&&request.method==='POST') {
      const payload=await readJSON(request);identity=participant(request);
      return await forward('host-contribute',{participantId:identity.id,payload});
    }
    if(path==='/api/pins'&&request.method==='GET') {
      const result=await room(env).fetch('https://room/list');
      return reply(await result.json(),result.status);
    }
    if(path==='/api/clear'&&request.method==='POST') {
      const result=await room(env).fetch('https://room/clear',{method:'POST'});
      return reply(await result.json(),result.status);
    }
    throw new HttpError(404,'That request could not be found.','not_found');
  } catch(error) {
    if(error instanceof HttpError) return reply({error:error.message,code:error.code},error.status);
    // Never log submitted names, places, cookies, passwords, or search URLs.
    return reply({error:'The room is temporarily unavailable. Please try again.',code:'room_unavailable'},503);
  }
}

// Opt-in experiment. The existing routes and room instance remain untouched.
async function relationalApi(request,env,url,password) {
  let identity=null;
  const reply=(data,status=200)=>json(data,status,identity?.cookie?{'Set-Cookie':identity.cookie}:{});
  const forward=async(action,payload)=>{
    const object=env.ROOM.get(env.ROOM.idFromName('class-relational-v2'));
    const result=await object.fetch(`https://room/relational/${action}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
    });
    return reply(await result.json(),result.status);
  };
  try {
    const path=url.pathname.slice('/api/v2'.length);
    if(['POST','PUT','PATCH','DELETE'].includes(request.method)&&request.headers.get('Origin')!==url.origin) {
      throw new HttpError(403,'This request could not be accepted.','origin_mismatch');
    }
    if(path==='/config'&&request.method==='GET') return reply(RELATIONAL_CONFIG);
    if(path==='/session'&&request.method==='GET') return reply({authenticated:await validSession(request,password)});
    if(path==='/state'&&request.method==='GET') {
      identity=participant(request);
      return await forward('state',{participantId:identity.id,host:false});
    }
    if(path==='/search'&&request.method==='GET') {
      identity=participant(request);
      const query=(url.searchParams.get('q')||'').trim();
      const round=url.searchParams.get('round')||'local';
      if(!['local','hometown'].includes(round)) throw new HttpError(400,'Choose a valid round.','invalid_round');
      if(query.length>120) throw new HttpError(400,'Please use a shorter place search.','invalid_search');
      if(query.length<2) return reply({results:[],source:'photon'});
      if(!participantSearches.check(identity.id)||!upstreamSearches.check('room')) throw new HttpError(429,'Please pause briefly before searching again.','search_rate_limited');
      participantSearches.hit(identity.id);upstreamSearches.hit('room');
      const result=await relationalSearch.search(query,round);
      return reply({...result,results:await Promise.all(result.results.map(place=>signPlace(place,round,url.origin,password)))});
    }
    if((path==='/join'||path==='/contributions')&&request.method==='POST') {
      const payload=await readJSON(request);identity=participant(request);
      if(!submissions.check(identity.id)) throw new HttpError(429,'Please pause briefly before sharing again.','submit_rate_limited');
      submissions.hit(identity.id);
      if(path==='/contributions') payload.place=await verifiedPlace(payload.place,payload.round,url.origin,password);
      return await forward(path==='/join'?'join':'contribute',{participantId:identity.id,payload});
    }
    if(path==='/contributions'&&request.method==='DELETE') {
      identity=participant(request);
      return await forward('remove',{participantId:identity.id,payload:{round:url.searchParams.get('round'),sessionId:url.searchParams.get('sessionId')}});
    }
    if(!(await validSession(request,password))) throw new HttpError(401,'Sign in to the presenter view first.','host_required');
    identity=participant(request);
    if(path==='/host/state'&&request.method==='GET') return await forward('state',{participantId:identity.id,host:true});
    if((path==='/host/control'||path==='/host/contributions')&&request.method==='POST') {
      const payload=await readJSON(request);
      if(path==='/host/contributions') payload.place=await verifiedPlace(payload.place,payload.round,url.origin,password);
      return await forward(path==='/host/control'?'control':'host-contribute',{participantId:identity.id,payload});
    }
    throw new HttpError(404,'That request could not be found.','not_found');
  } catch(error) {
    if(error instanceof HttpError) return reply({error:error.message,code:error.code},error.status);
    return reply({error:'The room is temporarily unavailable. Please try again.',code:'room_unavailable'},503);
  }
}

// Keep this exported class name, its namespace, and idFromName('class') stable.
// v2 state lives beside legacy pin:* / count keys; deployment never clears them.
export class Room {
  constructor(ctx) {
    this.ctx=ctx;
    this.tail=Promise.resolve();
    const initialize=async()=>{
      const saved=await ctx.storage.get(ROOM_STATE_KEY);
      this.model=new RoomModel(CONFIG);
      if(saved!==undefined) this.model.restore(saved);
      else await ctx.storage.put(ROOM_STATE_KEY,this.model.snapshot());
    };
    this.ready=typeof ctx.blockConcurrencyWhile==='function'?ctx.blockConcurrencyWhile(initialize):initialize();
  }
  fetch(request) {
    // Serialize application mutations, including the durable acknowledgement,
    // so simultaneous phones cannot replace each other's snapshots.
    const result=this.tail.then(()=>this.handle(request));
    this.tail=result.then(()=>undefined,()=>undefined);
    return result;
  }
  async handle(request) {
    try {
      await this.ready;
      const path=new URL(request.url).pathname;
      if(path.startsWith('/relational/')&&request.method==='POST') return await this.handleRelational(path.slice('/relational/'.length),await request.json());
      if(path.startsWith('/v2/')&&request.method==='POST') return await this.handleV2(path.slice(4),await request.json());
      if(path==='/add'&&request.method==='POST') {
        const pin=validPin(await request.json());
        if(!pin) return Response.json({error:'That pin could not be read.'},{status:400});
        const count=(await this.ctx.storage.get('count'))||0;
        if(count>=MAX_PINS) return Response.json({error:'The room is full.'},{status:429});
        const id=crypto.randomUUID().replace(/-/g,'');
        const at=Date.now();
        const key=`pin:${at.toString(36).padStart(9,'0')}${id.slice(0,6)}`;
        await this.ctx.storage.put({[key]:{id,at,...pin},count:count+1});
        return Response.json({ok:true,id});
      }
      if(path==='/list'&&request.method==='GET') {
        const entries=await this.ctx.storage.list({prefix:'pin:'});
        return Response.json({pins:[...entries.values()]});
      }
      if(path==='/clear'&&request.method==='POST') {
        const entries=await this.ctx.storage.list({prefix:'pin:'});
        const keys=[...entries.keys(),'count'];
        for(let start=0;start<keys.length;start+=128) await this.ctx.storage.delete(keys.slice(start,start+128));
        return Response.json({ok:true});
      }
      return Response.json({error:'Not found.'},{status:404});
    } catch(error) {
      if(error instanceof HttpError) return Response.json({error:error.message,code:error.code},{status:error.status});
      return Response.json({error:'The room is unavailable.',code:'room_unavailable'},{status:503});
    }
  }
  async handleV2(action,input) {
    if(!input||typeof input!=='object') throw new HttpError(400,'That request could not be read.','invalid_request');
    const before=this.model.snapshot();
    try {
      const payload=input.payload||{};
      if(action!=='state'&&payload.sessionId!==undefined&&payload.sessionId!==this.model.sessionId) {
        throw new HttpError(409,'The presenter has started a new room. Review your place before sharing again.','room_changed');
      }
      let data;
      if(action==='state') data=this.model.state(input.participantId,{host:input.host===true});
      else if(action==='contribute') {
        const entry=this.model.contribute(input.participantId,payload);
        data={entry,state:this.model.state(input.participantId)};
      } else if(action==='remove') {
        this.model.remove(input.participantId,payload.round);
        data={state:this.model.state(input.participantId)};
      } else if(action==='control') {
        this.model.control(payload.action);
        data={state:this.model.state(input.participantId,{host:true})};
      } else if(action==='host-contribute') {
        const entry=this.model.contribute('host-added-'+crypto.randomUUID(),payload);
        data={entry,state:this.model.state(input.participantId,{host:true})};
      } else throw new HttpError(404,'That request could not be found.','not_found');
      if(this.model.revision!==before.revision) await this.ctx.storage.put(ROOM_STATE_KEY,this.model.snapshot());
      return Response.json(data);
    } catch(error) {
      // A failed durable write must not be reported as a successful in-memory edit.
      this.model.restore(before);
      throw error;
    }
  }

  async handleRelational(action,input) {
    if(!this.relationalModel) {
      const saved=await this.ctx.storage.get(RELATIONAL_STATE_KEY);
      const model=new RelationalRoom(RELATIONAL_CONFIG);
      if(saved!==undefined) model.restore(saved);
      else await this.ctx.storage.put(RELATIONAL_STATE_KEY,model.snapshot());
      this.relationalModel=model;
    }
    if(!input||typeof input!=='object') throw new HttpError(400,'That request could not be read.','invalid_request');
    const model=this.relationalModel,before=model.snapshot();
    try {
      const payload=input.payload||{};
      if(action!=='state'&&payload.sessionId!==model.sessionId) {
        throw new HttpError(409,'The presenter has started a new room. Review your place before sharing again.','room_changed');
      }
      let data;
      if(action==='state') data=model.state(input.participantId,{host:input.host===true});
      else if(action==='join') data={member:model.join(input.participantId,payload),state:model.state(input.participantId)};
      else if(action==='contribute') data={entry:model.contribute(input.participantId,payload),state:model.state(input.participantId)};
      else if(action==='remove') {model.remove(input.participantId,payload.round);data={state:model.state(input.participantId)};}
      else if(action==='control') {model.control(payload.action,payload);data={state:model.state(input.participantId,{host:true})};}
      else if(action==='host-contribute') {
        let participantId='host-added-'+crypto.randomUUID();
        if(payload.memberId) {
          participantId=[...model.members].find(([,member])=>member.id===payload.memberId)?.[0];
          if(!participantId) throw new HttpError(400,'Choose a person who has joined this room.','invalid_member');
        }
        data={entry:model.contribute(participantId,payload),state:model.state(input.participantId,{host:true})};
      } else throw new HttpError(404,'That request could not be found.','not_found');
      if(model.revision!==before.revision) await this.ctx.storage.put(RELATIONAL_STATE_KEY,model.snapshot());
      return Response.json(data);
    } catch(error) {model.restore(before);throw error;}
  }
}
export default {
  async fetch(request,env) {
    try{return await handle(request,env);}
    catch{return response('The offering is temporarily unavailable. Please try again later.',503);}
  }
};
