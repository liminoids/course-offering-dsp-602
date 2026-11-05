/* join — one place you love here, then, at the end of class, where you came from */

const CAMPUS = { lng: -76.134, lat: 43.042 };
const $ = id => document.getElementById(id);
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

let state = {};
try { state = JSON.parse(localStorage.getItem('offering-join') || '{}') || {}; } catch (e) { state = {}; }
if (!state.pid) state.pid = hex(8);
function save() { try { localStorage.setItem('offering-join', JSON.stringify(state)); } catch (e) {} }
save();

function show(id) { for (const s of ['step1', 'done1', 'step2', 'done2']) $(s).hidden = s !== id; window.scrollTo(0, 0); }
if (state.step === 'done1') show('done1'); else if (state.step === 'done2') show('done2'); else show('step1');
if (state.who) { $('who').value = state.who; $('who2').value = state.who; }

function guessKind(place) {
  if (/coff|caf|tea|bakery|donut|bagel/i.test(place)) return 'coffee';
  if (/park|lake|trail|garden|wood|creek|quad|beach/i.test(place)) return 'park';
  if (/restaurant|pizza|taco|diner|bar|grill|market|kitchen|food|eat|deli|noodle|sushi|thai|pho|bbq/i.test(place)) return 'food';
  return 'home';
}

/* ───────── search-as-you-type, through the site's own geocoder ───────── */

function suggest(input, list, local, onPick) {
  let timer, seq = 0;
  function render(results) {
    list.innerHTML = '';
    for (const res of results) {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const name = document.createElement('span'); name.textContent = res.name;
      const where = document.createElement('span'); where.className = 'where'; where.textContent = res.label;
      b.append(name, where);
      b.addEventListener('click', () => { list.hidden = true; input.value = res.name; onPick(res); });
      li.appendChild(b); list.appendChild(li);
    }
    list.hidden = results.length === 0;
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await fetch('/api/geocode?q=' + encodeURIComponent(q) + '&local=' + (local ? 1 : 0));
        const { results = [] } = await r.json();
        if (my === seq) render(results);
      } catch (e) { list.hidden = true; }
    }, 300);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') list.hidden = true; });
}

async function send(pin) {
  try {
    const r = await fetch('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pin) });
    return r.ok;
  } catch (e) { return false; }
}

/* ───────── step one: here ───────── */

let chosen = null, marker = null, map = null;

function describe(res) { return res.name + (res.label ? ' — ' + res.label : ''); }

function choose(res) {
  chosen = res;
  $('chosen').textContent = describe(res);
  $('send1').disabled = false;
  if (map) {
    if (!marker) { const el = document.createElement('div'); el.className = 'pin'; marker = new maplibregl.Marker({ element: el }).setLngLat([res.lng, res.lat]).addTo(map); }
    else marker.setLngLat([res.lng, res.lat]);
    map.easeTo({ center: [res.lng, res.lat], zoom: Math.max(map.getZoom(), 14), duration: 700 });
  }
}

if (!$('step1').hidden) {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [CAMPUS.lng, CAMPUS.lat], zoom: 12.3,
    attributionControl: { compact: true },
    dragRotate: false, pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('load', () => {
    const t = { background: ['background-color', '#f7f4fb'], water: ['fill-color', '#dbe4fa'], park: ['fill-color', '#dff2e4'],
      landuse_residential: ['fill-color', '#f2eef8'], building: ['fill-color', '#ebe4f5'] };
    for (const [id, [k, v]] of Object.entries(t)) if (map.getLayer(id)) { try { map.setPaintProperty(id, k, v); } catch (e) {} }
  });
  map.on('click', e => {
    const typed = $('q').value.trim();
    choose({ name: typed || 'a place', label: 'where you tapped', kind: guessKind(typed), lng: e.lngLat.lng, lat: e.lngLat.lat });
  });
  suggest($('q'), $('suggest'), true, choose);
}

$('send1').addEventListener('click', async () => {
  if (!chosen) return;
  const btn = $('send1'); btn.disabled = true; btn.textContent = 'holding';
  state.who = $('who').value.trim().slice(0, 40); save();
  const ok = await send({ phase: 'local', place: chosen.name, who: state.who, kind: chosen.kind || 'home', lng: chosen.lng, lat: chosen.lat, pid: state.pid });
  if (ok) { state.step = 'done1'; save(); $('who2').value = state.who; show('done1'); }
  else { btn.disabled = false; btn.textContent = 'hold this place'; $('note1').textContent = 'That didn’t go through. Try once more.'; }
});

/* ───────── step two: where you came from ───────── */

let chosen2 = null;
suggest($('q2'), $('suggest2'), false, res => { chosen2 = res; $('chosen2').textContent = describe(res); $('send2').disabled = false; });

$('toHome').addEventListener('click', () => { show('step2'); $('q2').focus(); });

$('send2').addEventListener('click', async () => {
  if (!chosen2) return;
  const btn = $('send2'); btn.disabled = true; btn.textContent = 'holding';
  state.who = $('who2').value.trim().slice(0, 40); save();
  const ok = await send({ phase: 'home', place: chosen2.name, who: state.who, lng: chosen2.lng, lat: chosen2.lat, pid: state.pid });
  if (ok) { state.step = 'done2'; save(); show('done2'); }
  else { btn.disabled = false; btn.textContent = 'hold this place'; $('note2').textContent = 'That didn’t go through. Try once more.'; }
});

for (const id of ['again1', 'again2']) $(id).addEventListener('click', e => {
  e.preventDefault();
  state = { pid: state.pid, who: state.who }; save();
  location.reload();
});
