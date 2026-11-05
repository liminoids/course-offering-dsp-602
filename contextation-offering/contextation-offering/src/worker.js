// A small, password-protected Cloudflare Worker, adapted from viiibrant-hair.
// Configure SITE_PASSWORD as an encrypted Cloudflare runtime SECRET, never as a var.
// IMPORTANT: assets.run_worker_first must remain true to protect all static assets.

const COOKIE = '__Host-offering_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN = '/_gate/login';
const LOGOUT = '/_gate/logout';
const encoder = new TextEncoder();

// The join page (what classmates open on their phones) and the API it needs are open;
// the wall at / and everything else stay behind the password.
const PUBLIC = new Set(['/join', '/join.html', '/join.js', '/join.css']);
// Pages that draw a map need the map library, its tiles, and the fonts; nothing else is loosened.
const MAP_PAGES = new Set(['/', '/index.html', '/join', '/join.html']);
const MAP_CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org; worker-src blob:; child-src blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PHOTON = 'https://photon.komoot.io/api/';
const CAMPUS = {lat: 43.042, lon: -76.134};
const KINDS = new Set(['home', 'food', 'coffee', 'park']);
const MAX_PINS = 400;
const SOURCE_FILES = /^\/(?:_worker\.js|_routes\.json|_headers|wrangler\.(?:jsonc?|toml)|package(?:-lock)?\.json|src|tests|\.git|\.dev\.vars|\.env)(?:\/|$)/i;

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
  return page('the wall', `<h1>the wall</h1><p>This screen is for the room. Phones go to <code>/join</code>.</p>${error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : ''}<form method="post" action="${LOGIN}"><input type="hidden" name="next" value="${escapeHTML(next)}"><label for="password">password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="256"><button type="submit">open</button></form>`, status);
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
  if(url.pathname.startsWith('/api/')) return api(request,env,url,password);
  if(PUBLIC.has(url.pathname)) {
    if(request.method!=='GET' && request.method!=='HEAD') return response('Method not allowed.',405,{Allow:'GET, HEAD'});
    return serveAsset(request,env,url);
  }
  if(url.pathname===LOGIN && request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin) return response('This request could not be accepted.',403);
    const form=await readForm(request);
    if(!form || form.getAll('password').length!==1) return response('Invalid form.',400);
    const next=safeNext(form.get('next'),url.origin);
    const submitted=form.get('password');
    if(submitted.length>256 || !(await equalPassword(submitted,password))) return loginPage(next,'That password did not match. Please try again.',401);
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
  const asset=await env.ASSETS.fetch(request);
  const headers=new Headers(asset.headers);
  for(const [name,value] of Object.entries(BASE_HEADERS)) headers.set(name,value);
  if(MAP_PAGES.has(url.pathname)) headers.set('Content-Security-Policy',MAP_CSP);
  headers.delete('ETag');headers.delete('Last-Modified');
  return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
}

/* ───── the pins: a small API in front of one Durable Object that holds the room ───── */

function json(data,status=200) {
  return response(JSON.stringify(data),status,{'Content-Type':'application/json; charset=utf-8'});
}
function room(env) {
  return env.ROOM.get(env.ROOM.idFromName('class'));
}
async function readJSON(request) {
  if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json')) return null;
  if(Number(request.headers.get('Content-Length'))>4096) return null;
  const text=await request.text();
  if(text.length>4096) return null;
  try {return JSON.parse(text);} catch {return null;}
}
function cleanText(value,max) {
  return typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max) : '';
}
// One pin as a phone sends it: which act, the place, the optional name, where it is.
function validPin(body) {
  if(!body || typeof body!=='object') return null;
  const phase=body.phase==='home' ? 'home' : body.phase==='local' ? 'local' : null;
  const lng=Number(body.lng), lat=Number(body.lat);
  if(!phase || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng)>180 || Math.abs(lat)>85) return null;
  const place=cleanText(body.place,80) || 'a place';
  const who=cleanText(body.who,40);
  const kind=phase==='home' ? 'hometown' : (KINDS.has(body.kind) ? body.kind : 'home');
  const pid=typeof body.pid==='string' && /^[a-f0-9]{8,32}$/.test(body.pid) ? body.pid : '';
  return {phase,place,who,kind,lng:Math.round(lng*1e5)/1e5,lat:Math.round(lat*1e5)/1e5,pid};
}
function kindOf(props) {
  const v=`${props.osm_key||''}:${props.osm_value||''}`;
  if(/cafe|coffee|tea|bakery/.test(v)) return 'coffee';
  if(/restaurant|fast_food|bar|pub|food|ice_cream|mall|marketplace|supermarket|deli/.test(v)) return 'food';
  if(props.osm_key==='leisure' || props.osm_key==='natural' || /park|garden|wood|water|beach|trail/.test(v)) return 'park';
  return 'home';
}
// Place search for the phones (and the wall's typed panel): Photon, biased toward campus when local=1.
async function geocode(url) {
  const q=cleanText(url.searchParams.get('q'),100);
  if(q.length<2) return json({results:[]});
  const params=new URLSearchParams({q,limit:'6',lang:'en'});
  if(url.searchParams.get('local')==='1') {
    params.set('lat',String(CAMPUS.lat)); params.set('lon',String(CAMPUS.lon));
    params.set('location_bias_scale','0.6'); params.set('zoom','12');
  }
  let data;
  try {
    const upstream=await fetch(`${PHOTON}?${params}`,{headers:{'User-Agent':'contextation-offering/0.1 (class exercise)','Accept':'application/json'}});
    if(!upstream.ok) return json({results:[]},502);
    data=await upstream.json();
  } catch {return json({results:[]},502);}
  const results=(data.features||[]).map(f => {
    const p=f.properties||{}; const [lng,lat]=f.geometry.coordinates;
    const where=[p.city||p.town||p.village||p.county,p.state,p.country].filter(Boolean);
    return {name:cleanText(p.name||p.street||'',80),label:where.join(', '),kind:kindOf(p),lng,lat};
  }).filter(r => r.name);
  return json({results});
}
async function api(request,env,url,password) {
  const path=url.pathname;
  if(path==='/api/geocode' && request.method==='GET') return geocode(url);
  if(path==='/api/pin' && request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin) return json({error:'This request could not be accepted.'},403);
    const pin=validPin(await readJSON(request));
    if(!pin) return json({error:'That pin could not be read.'},400);
    const r=await room(env).fetch('https://room/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pin)});
    return json(await r.json(),r.status);
  }
  // Everything below is the wall's: it needs the password session.
  if(!(await validSession(request,password))) return json({error:'password'},401);
  if(path==='/api/pins' && request.method==='GET') {
    const r=await room(env).fetch('https://room/list');
    return json(await r.json(),r.status);
  }
  if(path==='/api/clear' && request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin) return json({error:'This request could not be accepted.'},403);
    const r=await room(env).fetch('https://room/clear',{method:'POST'});
    return json(await r.json(),r.status);
  }
  return json({error:'Not found.'},404);
}

// The room: every pin the class sends, in the order it arrived. One object, strongly consistent,
// created by the deploy itself (see migrations in wrangler.json) — no dashboard step.
export class Room {
  constructor(ctx) {this.ctx=ctx;}
  async fetch(request) {
    const path=new URL(request.url).pathname;
    try {
      if(path==='/add' && request.method==='POST') {
        const pin=await request.json();
        const count=(await this.ctx.storage.get('count'))||0;
        if(count>=MAX_PINS) return Response.json({error:'The room is full.'},{status:429});
        const id=crypto.randomUUID().replace(/-/g,'');
        const at=Date.now();
        const key=`pin:${at.toString(36).padStart(9,'0')}${id.slice(0,6)}`;
        await this.ctx.storage.put({[key]:{id,at,...pin},count:count+1});
        return Response.json({ok:true,id});
      }
      if(path==='/list' && request.method==='GET') {
        const map=await this.ctx.storage.list({prefix:'pin:'});
        return Response.json({pins:[...map.values()]});
      }
      if(path==='/clear' && request.method==='POST') {
        await this.ctx.storage.deleteAll();
        return Response.json({ok:true});
      }
    } catch {return Response.json({error:'The room is unavailable.'},{status:500});}
    return Response.json({error:'Not found.'},{status:404});
  }
}
export default {
  async fetch(request,env) {
    try{return await handle(request,env);}
    catch{return response('The offering is temporarily unavailable. Please try again later.',503);}
  }
};
