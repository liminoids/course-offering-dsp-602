/* A real geographic Canvas fallback for browsers without WebGL2.
 * Leaflet supplies controls and SVG overlays; OpenLayers draws the same
 * OpenFreeMap vector basemap used by the 3D renderer, without WebGL.
 * The public controller API and shared room clock match the 3D renderer.
 */
const BASEMAP_ATTRIBUTION = '&copy; <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · &copy; <a href="https://openmaptiles.org" target="_blank" rel="noopener noreferrer">OpenMapTiles</a> · &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
const DEFAULT_CENTER = { lat: 43.0421035, lng: -76.1339149, label: 'Whitman · Syracuse' };
const RAD = Math.PI / 180, EARTH_KM = 6371.0088, LOAD_TIMEOUT = 16000;
const COLORS = { pin: '#865c91', line: '#674372', center: '#594363', ring: '#ab8eb7' };
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const mix = (a, b, p) => a + (b - a) * p;
const smooth = p => { const t = clamp(p, 0, 1); return t * t * (3 - 2 * t); };
const wrap = lng => ((lng + 180) % 360 + 360) % 360 - 180;
let leafletPromise;
const stylePromises = new Map();

function cleanPlace(raw) {
  if (!raw || typeof raw.lat !== 'number' || typeof raw.lng !== 'number' ||
      !Number.isFinite(raw.lat) || !Number.isFinite(raw.lng) || Math.abs(raw.lat) > 85 || Math.abs(raw.lng) > 180) return null;
  return { ...raw, label: String(raw.label || 'Selected place').slice(0, 160) };
}
function settings(raw = {}) {
  return {
    ...raw, center: cleanPlace(raw.center || raw.campus) || DEFAULT_CENTER,
    radiusKm: Number(raw.radiusKm || raw.localRadiusKm) || 64.3736,
    inhaleMs: Number(raw.inhaleMs) || 5000, exhaleMs: Number(raw.exhaleMs) || 5000,
    localDurationMs: Number(raw.localDurationMs) || 50000,
    hometownDurationMs: Number(raw.hometownDurationMs) || 60000,
  };
}
function motionPreference() {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
}
function loadStyle(href) {
  if (!stylePromises.has(href)) {
    const pending = new Promise((resolve, reject) => {
      const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find(link => link.getAttribute('href') === href);
      if (existing?.sheet) { resolve(); return; }
      const link = existing || document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      let finished = false;
      const finish = error => {
        if (finished) return; finished = true; clearTimeout(timer);
        link.removeEventListener('load', loaded); link.removeEventListener('error', failed);
        if (error) { link.remove(); reject(error); } else resolve();
      };
      const loaded = () => finish(), failed = () => finish(new Error('Map styles could not load.'));
      const timer = setTimeout(() => finish(new Error('Map styles took too long to load.')), LOAD_TIMEOUT);
      link.addEventListener('load', loaded); link.addEventListener('error', failed);
      if (!existing) document.head.append(link);
    }).catch(error => { stylePromises.delete(href); throw error; });
    stylePromises.set(href, pending);
  }
  return stylePromises.get(href);
}
async function loadLeaflet() {
  if (!leafletPromise) leafletPromise = new Promise((resolve, reject) => {
    if (globalThis.L?.map && globalThis.L?.polyline) { resolve(globalThis.L); return; }
    const script = document.createElement('script'); script.src = '/vendor/leaflet.js'; script.async = true;
    let finished = false;
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer); script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve(globalThis.L);
    };
    script.onload = () => finish(globalThis.L?.map && globalThis.L?.polyline ? null : new Error('Map library is unavailable.'));
    script.onerror = () => finish(new Error('Map library could not load.'));
    const timer = setTimeout(() => finish(new Error('Map library took too long to load.')), LOAD_TIMEOUT);
    document.head.append(script);
  }).catch(error => { leafletPromise = null; throw error; });
  const [library] = await Promise.all([leafletPromise, loadStyle('/vendor/leaflet.css'), loadStyle('/map2d.css')]);
  return library;
}

export function distanceKm2D(a, b) {
  const lat = (b.lat - a.lat) * RAD, lng = (b.lng - a.lng) * RAD;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(lng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}
export function greatCirclePath2D(a, b, samples = 80) {
  const vector = p => [Math.cos(p.lat * RAD) * Math.cos(p.lng * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lng * RAD), Math.sin(p.lat * RAD)];
  const first = vector(a), last = vector(b), dot = clamp(first.reduce((sum, n, i) => sum + n * last[i], 0), -1, 1);
  const angle = Math.acos(dot), sine = Math.sin(angle), count = Math.max(2, Math.floor(samples));
  let orthogonal;
  if (dot < -0.999999) {
    const axis = Math.abs(first[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0];
    const projection = axis.reduce((sum, n, i) => sum + n * first[i], 0);
    orthogonal = axis.map((n, i) => n - projection * first[i]);
    const length = Math.hypot(...orthogonal); orthogonal = orthogonal.map(n => n / length);
  }
  return Array.from({ length: count + 1 }, (_, i) => {
    if (i === 0) return [a.lng, a.lat]; if (i === count) return [b.lng, b.lat];
    const p = i / count;
    const v = angle < 1e-8 ? first : orthogonal
      ? first.map((n, j) => n * Math.cos(Math.PI * p) + orthogonal[j] * Math.sin(Math.PI * p))
      : first.map((n, j) => n * Math.sin((1 - p) * angle) / sine + last[j] * Math.sin(p * angle) / sine);
    return [Math.atan2(v[1], v[0]) / RAD, Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD];
  });
}
// Split date-line crossings into separate geographic line segments. Never join
// +180 to -180 across a flat map, including exact-meridian and antipodal cases.
export function pathSegments2D(path, progress = 1) {
  if (!path?.length || progress <= 0) return [];
  const index = clamp(progress, 0, 1) * (path.length - 1), whole = Math.floor(index), fraction = index - whole;
  const points = path.slice(0, whole + 1);
  if (fraction > 0 && whole + 1 < path.length) {
    const a = path[whole], b = path[whole + 1];
    points.push([wrap(a[0] + wrap(b[0] - a[0]) * fraction), mix(a[1], b[1], fraction)]);
  }
  if (points.length < 2) return [];
  const segments = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], delta = b[0] - a[0];
    if (Math.abs(delta) <= 180) { segments.at(-1).push(b); continue; }
    const adjusted = b[0] + (delta > 180 ? -360 : 360);
    if (Math.abs(adjusted - a[0]) < 1e-10) { segments.at(-1).push([a[0], b[1]]); segments.push([b]); continue; }
    const boundary = adjusted > a[0] ? 180 : -180;
    const lat = mix(a[1], b[1], clamp((boundary - a[0]) / (adjusted - a[0]), 0, 1));
    segments.at(-1).push([boundary, lat]); segments.push([[-boundary, lat], b]);
  }
  return segments.filter(part => part.length >= 2).map(part => part.map(([lng, lat]) => [clamp(lat, -85, 85), lng]));
}
export function breathPosition2D(elapsed, duration, inhaleMs = 5000, exhaleMs = 5000) {
  const cycle = Math.max(1, inhaleMs + exhaleMs), cycles = Math.max(1, Math.round(duration / cycle));
  const cycleDuration = Math.max(1, duration / cycles), time = clamp(elapsed, 0, duration), complete = time >= duration;
  const index = complete ? cycles - 1 : Math.min(cycles - 1, Math.floor(time / cycleDuration));
  const within = complete ? cycle : (time - index * cycleDuration) / cycleDuration * cycle;
  return { index, cycles, rise: clamp(within / Math.max(1, inhaleMs), 0, 1), arrival: clamp((within - inhaleMs) / Math.max(1, exhaleMs), 0, 1) };
}
function timestamp(value) { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : null; }
function elapsedTime(clock = {}, now = Date.now()) {
  const start = timestamp(clock.startedAt), elapsed = Math.max(0, Number(clock.elapsedMs) || 0);
  return clamp(elapsed + (!clock.paused && start !== null ? Math.max(0, now - start) : 0), 0, Number(clock.durationMs) || Infinity);
}

function createSurface(container, { config, interactive, onStatus, onMap, onDispose }) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) throw new Error('A map container is required.');
  root.classList.add('offering2d-root', interactive ? 'offering2d-selection' : 'offering2d-presentation');
  const base = document.createElement('div'); base.className = 'offering2d-basemap'; base.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('div'); canvas.className = 'offering2d-canvas';
  const message = document.createElement('div'); message.className = 'offering2d-message'; message.setAttribute('role', 'status');
  const detail = document.createElement('p');
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try map again'; retry.hidden = true;
  message.append(detail, retry); root.append(base, canvas, message);
  let map = null, basemap = null, available = false, destroyed = false, generation = 0;
  let loadTimer = null, noticeTimer = null, hasLoaded = false;
  const notify = (text, state, ready = available) => { try { onStatus?.(text, { state, available: ready, ready, renderer: '2d' }); } catch {} };
  function loading(text = 'Opening the map…') {
    clearTimeout(noticeTimer); detail.textContent = text; message.hidden = false; retry.hidden = true;
    notify(text, 'loading', false);
  }
  function ready() {
    clearTimeout(loadTimer); clearTimeout(noticeTimer); available = true; hasLoaded = true;
    message.hidden = true; retry.hidden = true; root.classList.remove('offering2d-unavailable');
    notify('', 'ready', true);
  }
  function unavailable(text) {
    if (destroyed) return;
    clearTimeout(loadTimer); clearTimeout(noticeTimer); available = false;
    detail.textContent = text || (interactive ? 'Map data is unavailable. Use search, or retry.' : 'Map data is unavailable. The places remain listed.');
    message.hidden = false; retry.hidden = false; root.classList.add('offering2d-unavailable');
    notify(detail.textContent, 'unavailable', false);
  }
  function notice(text, persistent = false) {
    if (destroyed) return; clearTimeout(noticeTimer);
    detail.textContent = text; message.hidden = false; retry.hidden = !persistent;
    notify(text, 'notice', available);
    if (!persistent) noticeTimer = setTimeout(() => { if (available && !destroyed) message.hidden = true; }, 4500);
  }
  function release() {
    clearTimeout(loadTimer); clearTimeout(noticeTimer); onDispose?.();
    basemap?.destroy();
    if (map) { map.off(); map.remove(); }
    map = null; basemap = null; available = false; base.replaceChildren();
  }
  async function start() {
    if (destroyed) return;
    const version = ++generation; release(); hasLoaded = false; loading();
    root.classList.remove('offering2d-unavailable');
    try {
      const L = await loadLeaflet();
      if (destroyed || version !== generation) return;
      map = L.map(canvas, {
        center: [config.center.lat, config.center.lng], zoom: interactive ? 12 : 16.4,
        minZoom: 0, maxZoom: 19, zoomSnap: interactive ? 0.25 : 0, zoomDelta: 1,
        attributionControl: true, zoomControl: interactive,
        dragging: interactive, keyboard: interactive, scrollWheelZoom: interactive,
        doubleClickZoom: interactive, touchZoom: interactive, boxZoom: interactive,
        inertia: interactive && !motionPreference().matches, worldCopyJump: interactive,
        // A separate Canvas basemap follows Leaflet's geographic move events,
        // not Leaflet's CSS-only zoom interpolation.
        zoomAnimation: false, fadeAnimation: false,
        markerZoomAnimation: false, preferCanvas: false,
      });
      map.attributionControl.setPrefix(false);
      map.attributionControl.addAttribution(BASEMAP_ATTRIBUTION);
      map.getContainer().setAttribute('aria-label', interactive
        ? 'Map selector. Pan with arrow keys, then choose the map center, or use Search.'
        : 'Shared geographic map. The presenter controls also provide a text list of places.');
      if (!interactive) map.getContainer().setAttribute('tabindex', '-1');
      onMap(map, L);
      const target = document.createElement('div'); target.className = 'offering2d-basemap-target'; base.append(target);
      // Each attempt receives its own target. A slower obsolete initializer
      // cannot attach a Canvas or clear the DOM belonging to a newer retry.
      const leafletMap = map;
      const { createVectorBasemap } = await import('./vector-basemap.js');
      if (destroyed || version !== generation) return;
      loadTimer = setTimeout(() => { if (!hasLoaded && !destroyed && version === generation) unavailable(); }, LOAD_TIMEOUT + 4000);
      const adapter = await createVectorBasemap({
        map: leafletMap, container: target,
        onReady() { if (!destroyed && version === generation) ready(); },
        onError() { if (!destroyed && version === generation) unavailable(); },
        onNotice(text) { if (!destroyed && version === generation && available) notice(text || 'Part of the map could not load. You can retry.', true); },
      });
      if (destroyed || version !== generation) { adapter?.destroy(); return; }
      basemap = adapter;
    } catch { if (!destroyed && version === generation) { release(); unavailable('The map could not open. Check your connection and retry.'); } }
  }
  retry.addEventListener('click', start);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { map?.invalidateSize({ animate: false, pan: false }); basemap?.resize(); }) : null;
  observer?.observe(root);
  return {
    start, root, notify, notice,
    get map() { return map; }, get available() { return available; },
    resize() { map?.invalidateSize({ animate: false, pan: false }); basemap?.resize(); },
    destroy() {
      if (destroyed) return; destroyed = true; generation++; observer?.disconnect();
      retry.removeEventListener('click', start); release(); base.remove(); canvas.remove(); message.remove();
      root.classList.remove('offering2d-root', 'offering2d-selection', 'offering2d-presentation', 'offering2d-unavailable');
    },
  };
}

function labelNode(label, who = '') {
  const node = document.createElement('span'); node.textContent = label;
  if (who) { const person = document.createElement('small'); person.textContent = who; node.append(document.createElement('br'), person); }
  return node;
}
function circleMarker(L, map, place, center = false) {
  return L.circleMarker([place.lat, place.lng], {
    radius: center ? 7 : 6, color: '#fffafc', weight: 2, opacity: 1,
    fillColor: center ? COLORS.center : COLORS.pin, fillOpacity: 1, interactive: false,
  }).addTo(map);
}
function viewForBounds(map, L, coordinates, maxZoom = 16.4, padding = 45) {
  const bounds = L.latLngBounds(coordinates), zoom = clamp(map.getBoundsZoom(bounds, false, L.point(padding * 2, padding * 2)), 0, maxZoom);
  const sw = map.project(bounds.getSouthWest(), zoom), ne = map.project(bounds.getNorthEast(), zoom);
  const center = map.unproject(L.point((sw.x + ne.x) / 2, (sw.y + ne.y) / 2), zoom);
  return { lat: clamp(center.lat, -80, 80), lng: clamp(center.lng, -180, 180), zoom };
}
function worldView(map, L) { return viewForBounds(map, L, [[-65, -180], [80, 180]], 2, 30); }
function moveTo(map, pose, reduced = true) {
  map.stop();
  map.setView([pose.lat, pose.lng], pose.zoom, { animate: !reduced, duration: 0.5 });
}

export async function createSelectionMap2D(container, { config: rawConfig = {}, round: initialRound = 'local', onSelect, onStatus } = {}) {
  const config = settings(rawConfig), preference = motionPreference();
  let round = ['hometown', 'global', 'home'].includes(initialRound) ? 'hometown' : 'local';
  let selection = null, marker = null, boundary = null, library = null, destroyed = false;
  const surface = createSurface(container, {
    config, interactive: true, onStatus,
    onDispose() { marker = null; boundary = null; },
    onMap(map, L) {
      library = L;
      boundary = L.circle([config.center.lat, config.center.lng], {
        radius: config.radiusKm * 1000, color: COLORS.line, weight: 1.5, opacity: 0.55,
        dashArray: '4 4', fillColor: COLORS.ring, fillOpacity: 0.035, interactive: false,
      });
      map.on('click', event => select({ lat: event.latlng.lat, lng: wrap(event.latlng.lng), label: 'Selected place', kind: 'place' }));
      applyRound(); drawSelection();
    },
  });
  const centerButton = document.createElement('button'); centerButton.type = 'button'; centerButton.className = 'offering2d-center-button';
  centerButton.textContent = 'Choose map center'; centerButton.setAttribute('aria-label', 'Choose the location at the center of the map');
  centerButton.addEventListener('click', () => { const center = surface.map?.getCenter(); if (center) select({ lat: center.lat, lng: wrap(center.lng), label: 'Selected place', kind: 'place' }); });
  surface.root.append(centerButton);
  function select(raw) {
    if (!surface.available || destroyed) return;
    const place = cleanPlace(raw);
    if (!place) { surface.notice('Choose a place within the visible map.'); return; }
    if (round === 'local' && distanceKm2D(config.center, place) > config.radiusKm) {
      surface.notice(`Choose a place within about ${Math.round(config.radiusKm / 1.609344)} miles of Syracuse.`); return;
    }
    selection = place; drawSelection(); onSelect?.({ ...place });
  }
  function drawSelection() {
    const map = surface.map;
    if (!map || !library) return;
    if (!selection) { marker?.remove(); marker = null; return; }
    if (!marker) marker = circleMarker(library, map, selection);
    else marker.setLatLng([selection.lat, selection.lng]);
  }
  function applyRound() {
    const map = surface.map; if (!map || !library || !boundary) return;
    if (round === 'local') { boundary.addTo(map); moveTo(map, { ...config.center, zoom: 12 }); }
    else { boundary.remove(); moveTo(map, worldView(map, library)); }
  }
  function setSelection(raw) {
    selection = cleanPlace(raw); drawSelection();
    const map = surface.map;
    if (map && selection) moveTo(map, { ...selection, zoom: round === 'local' ? Math.max(12, map.getZoom()) : 7 }, preference.matches);
  }
  await surface.start();
  return {
    setRound(nextRound) {
      const next = ['hometown', 'global', 'home'].includes(nextRound) ? 'hometown' : 'local';
      if (next === round || destroyed) return; round = next; selection = null; drawSelection(); applyRound();
    },
    setSelection, setPlace: setSelection,
    resize() { surface.resize(); },
    destroy() { if (destroyed) return; destroyed = true; centerButton.remove(); surface.destroy(); },
  };
}

function normalizedEntries(state) {
  const raw = Array.isArray(state.entries) ? state.entries : [];
  const result = { local: [], hometown: [] };
  raw.forEach((entry, index) => {
    const place = cleanPlace(entry.place || entry); if (!place) return;
    const round = ['hometown', 'home'].includes(entry.round) ? 'hometown' : 'local';
    result[round].push({ ...place, id: String(entry.id || index) + '-' + round, who: entry.anonymous ? '' : String(entry.displayName || entry.who || '').slice(0, 60) });
  });
  return result;
}
function interpolatePose(a, b, progress) {
  return { lat: mix(a.lat, b.lat, progress), lng: mix(a.lng, b.lng, progress), zoom: mix(a.zoom, b.zoom, progress) };
}

export async function createPresentationMap2D(container, { config: rawConfig = {}, onStatus } = {}) {
  const config = settings(rawConfig), preference = motionPreference();
  let state = { phase: 'local_open', entries: [], clock: {} }, entries = { local: [], hometown: [] }, signature = '';
  let library = null, ring = null, origin = null, ringVisible = false, originLabel = '', lastPose = null;
  let paths = new Map(), threadLayers = new Map(), pinLayers = new Map(), poseCache = null;
  let raf = 0, lastDraw = -Infinity, labelsTimer = null, phaseEnteredAt = Date.now(), previousPhase = '';
  let serverOffset = 0, manualFreeze = null, pauseStarted = null, restFromPose = null, completePose = null, destroyed = false;
  const surface = createSurface(container, {
    config, interactive: false, onStatus,
    onDispose() {
      cancelAnimationFrame(raf); raf = 0; clearTimeout(labelsTimer); labelsTimer = null;
      threadLayers = new Map(); pinLayers = new Map(); origin = null; ring = null; ringVisible = false; originLabel = ''; lastPose = null; poseCache = null;
    },
    onMap(map, L) {
      library = L;
      origin = circleMarker(L, map, config.center, true).bindTooltip(labelNode(config.center.label), { permanent: true, direction: 'bottom', offset: [0, 9], className: 'offering2d-label offering2d-origin-label' });
      originLabel = config.center.label;
      ring = L.circle([config.center.lat, config.center.lng], { radius: 1, color: COLORS.ring, weight: 1, opacity: 0.3, fill: false, interactive: false });
      map.on('moveend', scheduleLabels);
      render(Date.now()); schedule();
    },
  });
  function refreshEntries() {
    const next = normalizedEntries(state), nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    for (const round of ['local', 'hometown']) next[round].sort((a, b) => distanceKm2D(config.center, a) - distanceKm2D(config.center, b) || a.id.localeCompare(b.id));
    entries = next; paths = new Map(); poseCache = null;
    for (const p of [...entries.local, ...entries.hometown]) paths.set(p.id, greatCirclePath2D(config.center, p, p.id.endsWith('local') ? 28 : 96));
  }
  function scheduleLabels() {
    if (labelsTimer !== null || destroyed) return;
    labelsTimer = setTimeout(() => { labelsTimer = null; arrangeLabels(); }, 250);
  }
  function arrangeLabels() {
    if (!surface.map || destroyed) return;
    const frame = surface.root.getBoundingClientRect(), placed = [];
    const originElement = origin?.getTooltip()?.getElement();
    if (originElement) placed.push(originElement.getBoundingClientRect());
    for (const record of pinLayers.values()) {
      const element = record.layer.getTooltip()?.getElement(); if (!element) continue;
      element.style.visibility = '';
      const rect = element.getBoundingClientRect();
      const overlaps = rect.left < frame.left + 6 || rect.right > frame.right - 6 || rect.top < frame.top + 8 || rect.bottom > frame.bottom - 35 ||
        placed.some(other => rect.left < other.right + 5 && rect.right > other.left - 5 && rect.top < other.bottom + 5 && rect.bottom > other.top - 5);
      if (overlaps) element.style.visibility = 'hidden'; else placed.push(rect);
    }
  }
  function camera(pose) {
    const map = surface.map; if (!map || !pose) return;
    if (lastPose && Math.abs(lastPose.lat - pose.lat) < 0.000001 && Math.abs(lastPose.lng - pose.lng) < 0.000001 && Math.abs(lastPose.zoom - pose.zoom) < 0.0001) return;
    map.setView([clamp(pose.lat, -80, 80), clamp(pose.lng, -180, 180)], clamp(pose.zoom, 0, 18), { animate: false });
    lastPose = pose; scheduleLabels();
  }
  function currentPose() {
    const map = surface.map; if (!map) return { ...config.center, zoom: 16.4 };
    const center = map.getCenter(); return { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
  }
  function radiusPose(radius) {
    const lat = radius / 110.574, lng = radius / Math.max(1, 111.32 * Math.cos(config.center.lat * RAD));
    return viewForBounds(surface.map, library, [
      [clamp(config.center.lat - lat, -85, 85), clamp(config.center.lng - lng, -180, 180)],
      [clamp(config.center.lat + lat, -85, 85), clamp(config.center.lng + lng, -180, 180)],
    ], 16.4, 55);
  }
  function localScene(elapsed, complete = false, shrink = 1) {
    const breath = breathPosition2D(complete ? config.localDurationMs : elapsed, config.localDurationMs, config.inhaleMs, config.exhaleMs);
    const radius = Math.max(0.8, ...entries.local.map(p => distanceKm2D(config.center, p))) * 1.12;
    const nextRadius = radius * (breath.index + 1) / breath.cycles;
    const progress = preference.matches ? (breath.arrival >= 1 ? 1 : 0) : smooth(breath.arrival);
    const threads = new Map(), pins = [];
    for (const p of entries.local) {
      const group = Math.min(breath.cycles - 1, Math.floor(distanceKm2D(config.center, p) / radius * breath.cycles));
      const amount = complete || group < breath.index ? 1 : group === breath.index ? progress : 0;
      if (amount * shrink > 0) threads.set(p.id, amount * shrink);
      if (amount >= 0.999 && shrink >= 0.999) pins.push(p);
    }
    const start = breath.index === 0 ? { ...config.center, zoom: 16.4 } : radiusPose(radius * breath.index / breath.cycles);
    const end = radiusPose(nextRadius), rise = preference.matches ? (breath.rise >= 1 ? 1 : 0) : smooth(breath.rise);
    return { threads, pins, radius: complete ? 0 : nextRadius, pose: interpolatePose(start, end, rise) };
  }
  function hometownPoses(cycles) {
    const size = surface.map.getSize(), key = `${signature}:${cycles}:${size.x}:${size.y}`;
    if (poseCache?.key === key) return poseCache.poses;
    const poses = []; let maxZoom = 4.5;
    for (let group = 0; group < cycles; group++) {
      const shown = entries.hometown.filter((_, index) => Math.floor(index * cycles / Math.max(1, entries.hometown.length)) <= group);
      const coordinates = [[config.center.lat, config.center.lng], ...shown.flatMap(p => pathSegments2D(paths.get(p.id)).flat())];
      const pose = viewForBounds(surface.map, library, coordinates, maxZoom, 65); maxZoom = pose.zoom; poses.push(pose);
    }
    poseCache = { key, poses }; return poses;
  }
  function draw(scene) {
    const map = surface.map; if (!map || !library) return;
    for (const [id, record] of threadLayers) if (!scene.threads.has(id)) { record.layer.remove(); threadLayers.delete(id); }
    for (const [id, amount] of scene.threads) {
      let record = threadLayers.get(id);
      if (!record) {
        record = { layer: library.polyline([], { color: COLORS.line, weight: 2.8, opacity: 0.86, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map), amount: -1 };
        threadLayers.set(id, record);
      }
      if (record.amount !== amount) { record.layer.setLatLngs(pathSegments2D(paths.get(id), amount)); record.amount = amount; }
    }
    const groups = new Map();
    for (const p of scene.pins) { const key = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(p); }
    let changed = false;
    for (const [key, record] of pinLayers) if (!groups.has(key)) { record.layer.remove(); pinLayers.delete(key); changed = true; }
    for (const [key, group] of groups) {
      const p = group[0], who = group.length > 1 ? `${group.length} contributions` : p.who;
      const contentKey = p.label + '\n' + who;
      let record = pinLayers.get(key);
      if (!record) {
        const layer = circleMarker(library, map, p).bindTooltip(labelNode(p.label, who), { permanent: true, direction: 'bottom', offset: [0, 8], className: 'offering2d-label' });
        record = { layer, contentKey }; pinLayers.set(key, record); changed = true;
      } else if (record.contentKey !== contentKey) { record.layer.setTooltipContent(labelNode(p.label, who)); record.contentKey = contentKey; changed = true; }
      record.layer.setRadius(Math.min(9, 5 + group.length));
    }
    if (changed) scheduleLabels();
    if (scene.radius > 0) { ring.setRadius(scene.radius * 1000); if (!ringVisible) { ring.addTo(map); ringVisible = true; } }
    else if (ringVisible) { ring.remove(); ringVisible = false; }
    if (scene.originLabel !== originLabel) { origin.setTooltipContent(labelNode(scene.originLabel)); originLabel = scene.originLabel; }
    origin.bringToFront();
  }
  function render(now) {
    if (!surface.map || !library || destroyed) return;
    const at = manualFreeze ?? now, phase = state.phase || 'local_open';
    const elapsed = elapsedTime(state.clock, at + serverOffset), reduced = preference.matches;
    let scene = { threads: new Map(), pins: [], radius: 0, originLabel: config.center.label, pose: { ...config.center, zoom: 16.4 } };
    if (phase === 'local_reveal') scene = { ...scene, ...localScene(Math.min(elapsed, config.localDurationMs)) };
    else if (phase === 'local_rest' || phase === 'hometown_open') scene = { ...scene, ...localScene(config.localDurationMs, true) };
    else if (phase === 'hometown_reveal') {
      scene.originLabel = 'Syracuse';
      const duration = Number(state.clock?.durationMs) || config.hometownDurationMs;
      const collapseMs = Math.min(config.inhaleMs + config.exhaleMs, duration / 3);
      if (elapsed < collapseMs) {
        const p = reduced ? 0 : smooth(elapsed / collapseMs), local = localScene(config.localDurationMs, true, 1 - p);
        scene = { ...scene, ...local, pose: interpolatePose(local.pose, { ...config.center, zoom: 4.5 }, p) };
      } else {
        const breath = breathPosition2D(elapsed - collapseMs, Math.max(1, duration - collapseMs), config.inhaleMs, config.exhaleMs);
        entries.hometown.forEach((p, index) => {
          const group = Math.min(breath.cycles - 1, Math.floor(index * breath.cycles / Math.max(1, entries.hometown.length)));
          const raw = group < breath.index ? 1 : group === breath.index ? breath.arrival : 0;
          const amount = reduced ? (raw >= 1 ? 1 : 0) : smooth(raw);
          if (amount > 0) scene.threads.set(p.id, amount); if (amount >= 0.999) scene.pins.push(p);
        });
        const poses = hometownPoses(breath.cycles), from = breath.index > 0 ? poses[breath.index - 1] : { ...config.center, zoom: 4.5 };
        scene.pose = interpolatePose(from, poses[breath.index], reduced ? (breath.rise >= 1 ? 1 : 0) : smooth(breath.rise));
      }
    } else if (phase === 'hometown_rest' || phase === 'complete') {
      scene.originLabel = 'Syracuse'; scene.pins = entries.hometown;
      for (const p of entries.hometown) scene.threads.set(p.id, 1);
      const target = worldView(surface.map, library);
      scene.pose = phase === 'complete' && completePose ? completePose : reduced || !restFromPose ? target : interpolatePose(restFromPose, target, smooth((at - phaseEnteredAt) / 4000));
    }
    camera(scene.pose); draw(scene);
  }
  function animating() {
    if (destroyed || manualFreeze !== null || document.hidden) return false;
    if (state.phase?.endsWith('_reveal')) return !state.clock?.paused && elapsedTime(state.clock, Date.now() + serverOffset) < (Number(state.clock?.durationMs) || Infinity);
    return state.phase === 'hometown_rest' && !preference.matches && Date.now() - phaseEnteredAt < 4000;
  }
  function tick(time) {
    raf = 0;
    if (time - lastDraw >= (preference.matches ? 250 : 80)) { lastDraw = time; render(Date.now()); }
    if (animating()) schedule(); else render(Date.now());
  }
  function schedule() { if (!raf && surface.map && animating()) raf = requestAnimationFrame(tick); }
  function onMotionChange() { render(Date.now()); if (!animating()) { cancelAnimationFrame(raf); raf = 0; } else schedule(); }
  function onVisibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else { render(Date.now()); schedule(); } }
  preference.addEventListener?.('change', onMotionChange); document.addEventListener('visibilitychange', onVisibility);
  await surface.start();
  return {
    update(next) {
      if (!next || typeof next !== 'object' || destroyed) return;
      const phase = next.phase || 'local_open';
      if (phase !== previousPhase) {
        phaseEnteredAt = Date.now(); restFromPose = currentPose();
        completePose = phase === 'complete' && previousPhase && surface.map ? currentPose() : null; previousPhase = phase;
      }
      const serverNow = timestamp(next.serverTime || next.serverNow); if (serverNow !== null) serverOffset = serverNow - Date.now();
      state = next; refreshEntries(); render(Date.now());
      if (!animating()) { cancelAnimationFrame(raf); raf = 0; } else schedule();
    },
    pause(paused = true) {
      if (paused && manualFreeze === null) { manualFreeze = Date.now(); pauseStarted = manualFreeze; }
      else if (!paused && manualFreeze !== null) { phaseEnteredAt += Date.now() - pauseStarted; manualFreeze = null; pauseStarted = null; }
      render(Date.now()); if (paused) { cancelAnimationFrame(raf); raf = 0; } else schedule();
    },
    resize() { surface.resize(); poseCache = null; lastPose = null; render(Date.now()); },
    destroy() {
      if (destroyed) return; destroyed = true; cancelAnimationFrame(raf); clearTimeout(labelsTimer);
      preference.removeEventListener?.('change', onMotionChange); document.removeEventListener('visibilitychange', onVisibility); surface.destroy();
    },
  };
}

export const createSelectionMap = createSelectionMap2D;
export const createPresentationMap = createPresentationMap2D;
