// A small, password-protected Cloudflare Worker, adapted from viiibrant-hair.
// Configure SITE_PASSWORD as an encrypted Cloudflare runtime SECRET, never as a var.
// IMPORTANT: assets.run_worker_first must remain true to protect all static assets.

const COOKIE = '__Host-offering_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN = '/_gate/login';
const LOGOUT = '/_gate/logout';
const encoder = new TextEncoder();

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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f6f3ed"><title>${escapeHTML(title)} · Offering</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;background:radial-gradient(circle at 12% 12%,#e7ebe3,transparent 35%),radial-gradient(circle at 85% 84%,#f0dfe1,transparent 42%),#f6f3ed;color:#273b34;display:grid;place-items:center;padding:28px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{width:min(100%,440px);padding:clamp(24px,5vw,44px);border:1px solid #ffffffbd;background:#ffffffbd;border-radius:26px;box-shadow:0 20px 65px #283f3412}.mark{margin:0 0 42px;font-family:Georgia,serif;font-size:22px;letter-spacing:-.025em}.mark i{font-weight:400;color:#b87b85}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:11px;font-weight:700;color:#7c8d7b}h1{font:normal clamp(34px,7vw,45px)/1.15 Georgia,serif;letter-spacing:-.045em;margin:12px 0 18px}p{margin:0 0 22px;color:#56675e}label{display:block;font-size:13px;font-weight:650;margin:22px 0 8px}input{width:100%;font:inherit;border:1px solid #bbc9bc;border-radius:12px;padding:13px 14px;background:white;min-height:48px}input:focus-visible,button:focus-visible{outline:3px solid #99b9a2;outline-offset:3px}button{width:100%;margin-top:16px;background:#273b34;color:#fff;border:0;border-radius:12px;min-height:48px;padding:12px 16px;cursor:pointer;font:600 15px/1.3 inherit}button:hover{background:#38574a}.foot{font-size:12px;color:#7a897f;margin:32px 0 0}.error{color:#9c3848;font-weight:600}code{font-size:.9em}
  </style></head><body><main class="card"><p class="mark">contextation <i>/ offering</i></p>${content}<p class="foot">A private space for shared attention.</p></main></body></html>`;
  return response(html, status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Browser-native POST forms must send Origin; same-origin referrer policy supports that.
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
}
function loginPage(next, error = '', status = 200) {
  return page('Enter password', `<p class="eyebrow">A shared space</p><h1>Begin here.</h1><p>Enter the class password to join the offering. No personal account is required.</p>${error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : ''}<form method="post" action="${LOGIN}"><input type="hidden" name="next" value="${escapeHTML(next)}"><label for="password">Shared password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="256"><button type="submit">Enter the offering</button></form>`, status);
}
function setupPage() {
  return page('Setup needed', `<p class="eyebrow">Not open yet</p><h1>Almost ready.</h1><p>The owner needs to set the encrypted <code>SITE_PASSWORD</code> secret (12–256 characters) in Cloudflare and deploy again.</p>`, 503);
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
    if(request.method==='GET') return page('Sign out','<p class="eyebrow">Leaving the space</p><h1>Sign out?</h1><p>This browser will need the shared password again.</p><form method="post" action="/_gate/logout"><button type="submit">Sign out</button></form>');
    return response('Method not allowed.',405,{Allow:'GET, POST'});
  }
  if(request.method!=='GET' && request.method!=='HEAD') return response('Method not allowed.',405,{Allow:'GET, HEAD'});
  if(url.pathname===LOGIN) return loginPage(safeNext(url.searchParams.get('next'),url.origin));
  if(!(await validSession(request,password))) return redirect(`${LOGIN}?next=${encodeURIComponent(safeNext(url.pathname+url.search,url.origin))}`);
  // Safeguard against serving deployment source files, even if accidentally copied into dist.
  if(/^\/(?:_worker\.js|_routes\.json|_headers|wrangler\.(?:jsonc?|toml)|package(?:-lock)?\.json|src|tests|\.git|\.dev\.vars|\.env)(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return response('Not found.',404);
  const asset=await env.ASSETS.fetch(request);
  const headers=new Headers(asset.headers);
  for(const [name,value] of Object.entries(BASE_HEADERS)) headers.set(name,value);
  headers.delete('ETag');headers.delete('Last-Modified');
  return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
}
export default {
  async fetch(request,env) {
    try{return await handle(request,env);}
    catch{return response('The offering is temporarily unavailable. Please try again later.',503);}
  }
};
