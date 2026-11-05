/* the wall — the room's pins, the threads, the zoom. keys: → next, h hometown, p play, e type, x clear, r restart */

const BUILDING = { name: 'here', lng: -76.1339149, lat: 43.0421035 }; // Whitman, 721 University Ave
const PACE = 6500;        // ms between threads when playing (p)
const POLL = 2500;        // ms between looks at the room

const KIND = {
  home:     { color: '#ffc89a', halo: '#ffe4cb', word: 'home' },
  food:     { color: '#ffb3c7', halo: '#ffdbe5', word: 'food' },
  coffee:   { color: '#e6cdb0', halo: '#f3e6d6', word: 'coffee' },
  park:     { color: '#a9dfc0', halo: '#d6f1e2', word: 'park' },
  hometown: { color: '#c9b8ff', halo: '#e5dcff', word: 'came from here' },
};
const THREAD = {
  local: { core: '#ef9fcc', halo: '#ffd3ea' },
  world: { core: '#b9a6f2', halo: '#e2daff' },
};

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const D = reduce ? 0.3 : 1;
const SYR = { name: 'Syracuse', lng: BUILDING.lng, lat: BUILDING.lat };

const $ = id => document.getElementById(id);
const fc = features => ({ type: 'FeatureCollection', features });
const pt = (p, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
const wait = ms => new Promise(r => setTimeout(r, ms));
const easeInOutCubic = u => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
const easeOutCubic = u => 1 - Math.pow(1 - u, 3);
const easeOutBack = u => reduce ? easeOutCubic(u) : 1 + 2.3 * Math.pow(u - 1, 3) + 1.3 * Math.pow(u - 1, 2);

/* ───────── geometry ───────── */

function ang(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(h)) / r;
}
function arc(a, b, n) {
  const r = Math.PI / 180, d = ang(a, b) * r;
  const f1 = a.lat * r, l1 = a.lng * r, f2 = b.lat * r, l2 = b.lng * r;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    if (d < 1e-9) { out.push([a.lng, a.lat]); continue; }
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
    const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
    const z = A * Math.sin(f1) + B * Math.sin(f2);
    out.push([Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
  }
  return out;
}
const mid = (a, b) => { const m = arc(a, b, 2)[1]; return { lng: m[0], lat: m[1] }; };
const sortNear = (list, from) => [...list].sort((a, b) => ang(from, a) - ang(from, b));

function slice(path, f) {
  if (f <= 0) return [path[0], path[0]];
  if (f >= 1) return path;
  const n = path.length - 1, x = f * n, i = Math.floor(x), u = x - i;
  const a = path[i], b = path[Math.min(i + 1, n)];
  const lng = Math.abs(b[0] - a[0]) > 180 ? a[0] : a[0] + (b[0] - a[0]) * u;
  return path.slice(0, i + 1).concat([[lng, a[1] + (b[1] - a[1]) * u]]);
}
function geom(coords) {
  const parts = [[coords[0]]];
  for (let i = 1; i < coords.length; i++) {
    if (Math.abs(coords[i][0] - coords[i - 1][0]) > 180) parts.push([]);
    parts[parts.length - 1].push(coords[i]);
  }
  const ok = parts.filter(p => p.length > 1);
  return ok.length === 1 ? { type: 'LineString', coordinates: ok[0] } : { type: 'MultiLineString', coordinates: ok };
}

/* ───────── the room's pins ───────── */

const live = { local: [], home: [] };   // what phones sent
const typed = { local: [], home: [] };  // what was typed into the panel
const shown = new Set();                // ids already threaded
const allLocal = () => live.local.concat(typed.local);
const allHome = () => live.home.concat(typed.home);
let signedOut = false;

async function poll() {
  try {
    const r = await fetch('/api/pins', { cache: 'no-store' });
    if (r.status === 401) { signedOut = true; count(); return; }
    const { pins = [] } = await r.json();
    signedOut = false;
    live.local = pins.filter(p => p.phase === 'local').map(p => ({ id: p.id, name: p.place, who: p.who, kind: p.kind, lng: p.lng, lat: p.lat }));
    live.home = pins.filter(p => p.phase === 'home').map(p => ({ id: p.id, name: p.place, who: p.who, kind: 'hometown', lng: p.lng, lat: p.lat }));
    count();
  } catch (e) { /* the next look will try again */ }
}
function count() {
  const el = $('count');
  if (signedOut) { el.innerHTML = ''; const a = document.createElement('a'); a.href = '/_gate/login?next=/'; a.textContent = 'password needed'; el.appendChild(a); return; }
  el.textContent = (phase === 'world' || phase === 'turning')
    ? allHome().length + ' hometowns held'
    : allLocal().length + ' places held';
}

/* ───────── the map ───────── */

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [BUILDING.lng, BUILDING.lat],
  zoom: 16.4, pitch: 58, bearing: -24,
  attributionControl: { compact: true },
  canvasContextAttributes: { antialias: true },
});
map.on('error', e => console.warn(e && e.error));

let phase = 'idle', busy = false, playing = false, playTimer = null, turning = false, spinLng = 0;
const threads = [];
const pins = [];
let hereLabel = BUILDING.name, hereR = 7, hereHalo = 16;

map.on('load', () => {
  map.setProjection({ type: 'globe' });
  tint();
  const firstSymbol = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
  map.addLayer({
    id: 'blocks', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    paint: {
      'fill-extrusion-color': '#ebe4f5',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.92,
    },
  }, firstSymbol);
  for (const id of ['threads', 'pins', 'sparks', 'here']) map.addSource(id, { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'thread-halo', type: 'line', source: 'threads', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'halo'], 'line-width': 12, 'line-blur': 9, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'thread', type: 'line', source: 'threads', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'core'], 'line-width': 3 } });
  map.addLayer({ id: 'pin-halo', type: 'circle', source: 'pins',
    paint: { 'circle-color': ['get', 'halo'], 'circle-radius': ['get', 'haloR'], 'circle-opacity': ['get', 'haloO'], 'circle-blur': 0.6 } });
  map.addLayer({ id: 'pin', type: 'circle', source: 'pins',
    paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['get', 'r'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.2 } });
  map.addLayer({ id: 'pin-label', type: 'symbol', source: 'pins',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 15,
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 12, 'text-line-height': 1.25 },
    paint: { 'text-color': '#5e4d6e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6, 'text-opacity': ['get', 'o'] } });
  map.addLayer({ id: 'sparks', type: 'circle', source: 'sparks',
    paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['get', 'r'], 'circle-opacity': ['get', 'o'] } });
  map.addLayer({ id: 'here-halo', type: 'circle', source: 'here',
    paint: { 'circle-color': '#d9c9ff', 'circle-radius': ['get', 'haloR'], 'circle-opacity': 0.45, 'circle-blur': 0.7 } });
  map.addLayer({ id: 'here', type: 'circle', source: 'here',
    paint: { 'circle-color': '#b9a6f2', 'circle-radius': ['get', 'r'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.4 } });
  map.addLayer({ id: 'here-label', type: 'symbol', source: 'here',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 16, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#5e4d6e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 } });
  drawHere(); drawPins(); drawThreads();
  caption(BUILDING.name, 'where we are');
  poll(); setInterval(poll, POLL);
});

function tint() {
  const t = {
    background: ['background-color', '#f7f4fb'],
    water: ['fill-color', '#dbe4fa'],
    waterway: ['line-color', '#c9d6f5'],
    park: ['fill-color', '#dff2e4'],
    landcover_wood: ['fill-color', '#e6f2e8'],
    landuse_residential: ['fill-color', '#f2eef8'],
    building: ['fill-color', '#ebe4f5'],
    boundary_2: ['line-color', '#d9cfe8'],
    boundary_3: ['line-color', '#e3dced'],
  };
  for (const [id, [k, v]] of Object.entries(t)) if (map.getLayer(id)) { try { map.setPaintProperty(id, k, v); } catch (e) {} }
}

function drawHere() { map.getSource('here').setData(fc([pt(BUILDING, { label: hereLabel, r: hereR, haloR: hereHalo })])); }
function drawPins() {
  map.getSource('pins').setData(fc(pins.map(x => pt(x.p, { label: x.label, color: x.color, halo: x.halo, r: x.r, haloR: x.haloR, haloO: x.haloO, o: x.o }))));
}
function drawThreads() {
  map.getSource('threads').setData(fc(threads.map(t => ({ type: 'Feature', properties: { core: t.core, halo: t.halo }, geometry: geom(slice(t.path, t.progress)) }))));
}
function animate(dur, ease, step) {
  return new Promise(res => {
    const t0 = performance.now();
    (function frame(now) {
      const u = Math.min(1, (now - t0) / Math.max(1, dur));
      step(ease(u));
      if (u < 1) requestAnimationFrame(frame); else res();
    })(t0);
  });
}
function caption(name, who) {
  const c = $('caption');
  c.classList.remove('show');
  $('capName').textContent = name;
  $('capWho').textContent = who || '';
  requestAnimationFrame(() => requestAnimationFrame(() => c.classList.add('show')));
}
const hideHint = () => $('hint').classList.add('gone');

/* ───────── the threads ───────── */

function pending(list, from) { return sortNear(list.filter(p => !shown.has(p.id)), from); }

function next() {
  if (busy) return;
  if (phase === 'idle') phase = 'local';
  if (phase === 'local') {
    const p = pending(allLocal(), BUILDING)[0];
    if (!p) { caption(allLocal().length ? 'all of us' : 'waiting', allLocal().length ? 'here' : 'no places yet'); stopPlaying(); return; }
    shoot(p);
  } else if (phase === 'world') {
    const p = pending(allHome(), SYR)[0];
    if (!p) { if (allHome().length) startTurning(); else { caption('waiting', 'no hometowns yet'); stopPlaying(); } return; }
    shoot(p);
  }
}

function shoot(p) {
  busy = true; hideHint(); shown.add(p.id);
  const world = phase === 'world';
  const from = world ? SYR : BUILDING;
  const look = THREAD[world ? 'world' : 'local'];
  const t = { path: arc(from, p, world ? 96 : 24), progress: 0, core: look.core, halo: look.halo };
  threads.push(t);
  const kind = world ? KIND.hometown : (KIND[p.kind] || KIND.home);
  const pin = { p, world, label: p.who ? p.name + '\n' + p.who : p.name, color: kind.color, halo: kind.halo, r: 0, haloR: 0, haloO: 0, o: 0 };
  pins.push(pin);
  frameCamera(p, world);
  animate((world ? 2600 : 1700) * D, easeInOutCubic, u => { t.progress = u; drawThreads(); })
    .then(() => { caption(p.name, p.who || kind.word); return drop(pin); })
    .then(() => {
      busy = false;
      const more = world ? pending(allHome(), SYR).length : pending(allLocal(), BUILDING).length;
      if (!more) { if (world) startTurning(); else stopPlaying(); }
      else if (playing) schedule();
    });
}

function frameCamera(p, world) {
  if (!world) {
    const pts = [[BUILDING.lng, BUILDING.lat], ...pins.map(x => [x.p.lng, x.p.lat])];
    const b = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const cam = map.cameraForBounds(b, { padding: { top: 140, bottom: 220, left: 160, right: 160 }, bearing: map.getBearing() });
    if (cam) map.easeTo({ center: cam.center, zoom: Math.min(cam.zoom - 0.3, 16.0), pitch: 50, bearing: map.getBearing(),
      duration: 2300 * D, easing: easeInOutCubic });
  } else {
    const d = ang(SYR, p);
    const zoom = d < 6 ? 5.0 : d < 15 ? 3.9 : d < 35 ? 3.0 : d < 60 ? 2.6 : 2.3;
    const c = d > 25 ? mid(SYR, p) : SYR;
    map.easeTo({ center: [c.lng, c.lat], zoom, pitch: 0, bearing: 0, duration: 2600 * D, easing: easeInOutCubic });
  }
}

function drop(pin) {
  const R = 7;
  if (!reduce) spark(pin.p);
  return animate(650 * D, easeOutBack, u => {
    pin.r = R * u; pin.o = Math.min(1, u); pin.haloR = 26 * u; pin.haloO = Math.max(0, 0.6 * (1 - u) + 0.15);
    drawPins();
  }).then(() => { pin.r = R; pin.haloR = 14; pin.haloO = 0.35; pin.o = 1; drawPins(); });
}

function spark(p) {
  const parts = Array.from({ length: 7 }, (_, i) => ({
    a: i / 7 * Math.PI * 2 + Math.random() * .5, d: 14 + Math.random() * 16, c: i % 2 ? '#ffe1f3' : '#fff2b8',
  }));
  animate(700 * D, easeOutCubic, u => {
    const c = map.project([p.lng, p.lat]);
    map.getSource('sparks').setData(fc(parts.map(s => {
      const q = map.unproject([c.x + Math.cos(s.a) * s.d * u, c.y + Math.sin(s.a) * s.d * u - 6 * u]);
      return { type: 'Feature', properties: { c: s.c, r: 3 * (1 - u) + .5, o: 1 - u }, geometry: { type: 'Point', coordinates: [q.lng, q.lat] } };
    })));
  }).then(() => map.getSource('sparks').setData(fc([])));
}

/* ───────── syracuse becomes one, then the world ───────── */

async function collapse() {
  if (busy || phase === 'collapse' || phase === 'world' || phase === 'turning') return;
  busy = true; phase = 'collapse'; stopPlaying(); hideHint();
  caption('Syracuse', 'all of us');
  map.easeTo({ center: [SYR.lng, SYR.lat], zoom: 9.2, pitch: 0, bearing: 0, duration: 3200 * D, easing: easeInOutCubic });
  await animate(1800 * D, easeInOutCubic, u => {
    for (const t of threads) t.progress = 1 - u;
    for (const x of pins) { x.r = 7 * (1 - u); x.o = 1 - u; x.haloO = 0.35 * (1 - u); }
    drawThreads(); drawPins();
  });
  threads.length = 0; pins.length = 0; drawThreads(); drawPins();
  hereLabel = SYR.name;
  await animate(900 * D, easeOutCubic, u => { hereR = 7 + 4 * u; hereHalo = 16 + 18 * u; drawHere(); });
  await wait(800 * D);
  map.easeTo({ center: [SYR.lng, SYR.lat], zoom: 5.6, pitch: 0, bearing: 0, duration: 2400 * D, easing: easeInOutCubic });
  await wait(2400 * D);
  phase = 'world'; busy = false; count();
}

function startTurning() {
  phase = 'turning'; stopPlaying(); count();
  caption('all of us', 'where we came from');
  map.easeTo({ center: [SYR.lng, 18], zoom: 2.3, pitch: 0, bearing: 0, duration: 3000 * D, easing: easeInOutCubic });
  setTimeout(() => { spinLng = map.getCenter().lng; turning = true; spin(); }, 3000 * D + 50);
}
function spin() {
  if (!turning) return;
  spinLng -= reduce ? 0.015 : 0.045;
  if (spinLng < -180) spinLng += 360;
  map.jumpTo({ center: [spinLng, 18] });
  requestAnimationFrame(spin);
}

/* ───────── driving it ───────── */

function schedule() { clearTimeout(playTimer); playTimer = setTimeout(next, PACE * D); }
function stopPlaying() { playing = false; clearTimeout(playTimer); }
function togglePlay() { playing = !playing; if (playing) next(); else clearTimeout(playTimer); }
function step() {
  if (phase === 'turning') { turning = !turning; if (turning) spin(); return; }
  next();
}
async function clearRoom() {
  if (!confirm('Clear every pin in the room? This is for starting a fresh class.')) return;
  try {
    const r = await fetch('/api/clear', { method: 'POST' });
    if (r.ok) { live.local = []; live.home = []; typed.local = []; typed.home = []; shown.clear(); location.reload(); }
  } catch (e) {}
}

addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('.panel')) { if (e.key === 'Escape') togglePanel(false); return; }
  if (e.key === 'e' || e.key === 'E') { togglePanel(); return; }
  if (['ArrowRight', ' ', 'PageDown', 'Enter'].includes(e.key)) { e.preventDefault(); step(); }
  else if (e.key === 'h' || e.key === 'H') collapse();
  else if (e.key === 'p' || e.key === 'P') togglePlay();
  else if (e.key === 'x' || e.key === 'X') clearRoom();
  else if (e.key === 'r' || e.key === 'R') location.reload();
});
map.on('click', step);

/* ───────── typing places in, for when a phone can't ───────── */

function togglePanel(show) {
  const p = $('panel');
  p.hidden = show === undefined ? !p.hidden : !show;
  if (!p.hidden) $('inLocal').focus();
}
const status = t => { $('status').textContent = t; };

function parseLines(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^([^:—]+?)\s*[:—]\s*(.+)$/);
    return m ? { who: m[1].trim(), place: m[2].trim() } : { who: '', place: s };
  });
}
async function geocode(place, local) {
  try {
    const r = await fetch('/api/geocode?q=' + encodeURIComponent(place) + '&local=' + (local ? 1 : 0));
    const { results = [] } = await r.json();
    return results[0] || null;
  } catch (e) { return null; }
}
let typedN = 0;
async function applyLists() {
  const btn = $('apply'); btn.disabled = true;
  const L = parseLines($('inLocal').value), H = parseLines($('inHome').value);
  localStorage.setItem('wall-lines', JSON.stringify({ l: $('inLocal').value, h: $('inHome').value }));
  const missing = [];
  let i = 0; const total = L.length + H.length;
  for (const e of L) { status('finding ' + (++i) + ' of ' + total); const g = await geocode(e.place, true);
    if (g) typed.local.push({ id: 'typed-' + (++typedN), name: e.place, who: e.who, kind: g.kind || 'home', lng: g.lng, lat: g.lat }); else missing.push(e.place); }
  for (const e of H) { status('finding ' + (++i) + ' of ' + total); const g = await geocode(e.place, false);
    if (g) typed.home.push({ id: 'typed-' + (++typedN), name: e.place, who: e.who, kind: 'hometown', lng: g.lng, lat: g.lat }); else missing.push(e.place); }
  $('inLocal').value = ''; $('inHome').value = '';
  status(missing.length ? 'couldn’t find: ' + missing.join(', ') + ' — try another spelling' : 'added');
  btn.disabled = false; count();
}
$('apply').addEventListener('click', applyLists);
try {
  const saved = JSON.parse(localStorage.getItem('wall-lines') || 'null');
  if (saved) { $('inLocal').value = saved.l || ''; $('inHome').value = saved.h || ''; }
} catch (e) {}
