/*
 * Real geographic views for Offering.
 * Runtime map dependency: MapLibre GL JS 6.16.0, loaded in the browser from UNPKG.
 * Basemap: OpenFreeMap Liberty. Both require an Internet connection.
 * Official sources checked during implementation:
 * https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-vector-map/
 * https://openfreemap.org/quick_start/
 *
 * onStatus receives (message, {state, available, ready}).
 * Map failure never changes submitted places or substitutes invented geography.
 */

const MAPLIBRE_VERSION = '6.16.0';
const MAPLIBRE_MODULE = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`;
const MAPLIBRE_CSS = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const LOAD_TIMEOUT_MS = 16000;
const R = 6371.0088;
const RAD = Math.PI / 180;
const DEFAULT_CENTER = { lng: -76.1339149, lat: 43.0421035, label: 'Whitman · Syracuse' };
const COLORS = { pin: '#865c91', line: '#674372', halo: '#d6bbdf', center: '#594363', ring: '#ab8eb7' };
const EMPTY = () => ({ type: 'FeatureCollection', features: [] });
const collection = features => ({ type: 'FeatureCollection', features });
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const mix = (a, b, p) => a + (b - a) * p;
const smooth = p => { const t = clamp(p, 0, 1); return t * t * (3 - 2 * t); };
const wrapLng = value => ((value + 180) % 360 + 360) % 360 - 180;
const shortestLng = (a, b, p) => wrapLng(a + wrapLng(b - a) * p);
let libraryPromise;
let cssPromise;

function isPlace(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
    Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
}
function cleanPlace(p) {
  if (!isPlace(p)) return null;
  return { ...p, lat: Number(p.lat), lng: Number(p.lng), label: String(p.label || p.place || 'A chosen place').slice(0, 160) };
}
function settings(config = {}) {
  const center = cleanPlace(config.center || config.campus) || DEFAULT_CENTER;
  return {
    ...config, center,
    radiusKm: Number(config.radiusKm || config.localRadiusKm) || 64.3736,
    inhaleMs: Number(config.inhaleMs) || 5000,
    exhaleMs: Number(config.exhaleMs) || 5000,
    localDurationMs: Number(config.localDurationMs) || 50000,
    hometownDurationMs: Number(config.hometownDurationMs) || 60000,
  };
}

/** Great-circle distance, used for the visible local boundary and selection feedback. */
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

/** Finite spherical interpolation, including coincident and antipodal destinations. */
export function greatCirclePath(a, b, samples = 80) {
  const v = p => [Math.cos(p.lat * RAD) * Math.cos(p.lng * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lng * RAD), Math.sin(p.lat * RAD)];
  const first = v(a), last = v(b);
  const dot = clamp(first.reduce((sum, x, i) => sum + x * last[i], 0), -1, 1);
  const angle = Math.acos(dot), sin = Math.sin(angle);
  let orthogonal;
  if (dot < -0.999999) {
    const axis = Math.abs(first[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0];
    const projection = axis.reduce((sum, x, i) => sum + x * first[i], 0);
    orthogonal = axis.map((x, i) => x - projection * first[i]);
    const length = Math.hypot(...orthogonal);
    orthogonal = orthogonal.map(x => x / length);
  }
  const points = [];
  const count = Math.max(2, Math.floor(samples));
  for (let i = 0; i <= count; i++) {
    if (i === 0) { points.push([a.lng, a.lat]); continue; }
    if (i === count) { points.push([b.lng, b.lat]); continue; }
    const p = i / count;
    let vector;
    if (angle < 1e-8) vector = first;
    else if (orthogonal) vector = first.map((x, j) => x * Math.cos(Math.PI * p) + orthogonal[j] * Math.sin(Math.PI * p));
    else {
      const x = Math.sin((1 - p) * angle) / sin, y = Math.sin(p * angle) / sin;
      vector = first.map((value, j) => x * value + y * last[j]);
    }
    points.push([Math.atan2(vector[1], vector[0]) / RAD, Math.atan2(vector[2], Math.hypot(vector[0], vector[1])) / RAD]);
  }
  return points;
}
function slicePath(path, progress) {
  const p = clamp(progress, 0, 1);
  if (p <= 0) return [path[0], path[0]];
  if (p >= 1) return path;
  const index = p * (path.length - 1), whole = Math.floor(index), fraction = index - whole;
  const a = path[whole], b = path[Math.min(whole + 1, path.length - 1)];
  return [...path.slice(0, whole + 1), [shortestLng(a[0], b[0], fraction), mix(a[1], b[1], fraction)]];
}
/** Split the date line explicitly so flat-map fallback never draws a line across the world. */
export function lineGeometry(path) {
  if (!path.length) return { type: 'LineString', coordinates: [[0, 0], [0, 0]] };
  const parts = [[path[0]]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const delta = b[0] - a[0];
    if (Math.abs(delta) > 180) {
      const adjustedB = b[0] + (delta > 180 ? -360 : 360);
      // +180 and -180 describe the same meridian. Close this side before
      // continuing on the other, without dividing by a zero-length crossing.
      if (Math.abs(adjustedB - a[0]) < 1e-10) {
        parts.at(-1).push([a[0], b[1]]);
        parts.push([b]);
        continue;
      }
      const boundary = adjustedB > a[0] ? 180 : -180;
      const fraction = (boundary - a[0]) / (adjustedB - a[0]);
      const latitude = mix(a[1], b[1], clamp(fraction, 0, 1));
      parts.at(-1).push([boundary, latitude]);
      parts.push([[-boundary, latitude], b]);
    } else parts.at(-1).push(b);
  }
  const valid = parts.filter(part => part.length >= 2);
  if (!valid.length) return { type: 'LineString', coordinates: [path[0], path[0]] };
  return valid.length === 1 ? { type: 'LineString', coordinates: valid[0] } : { type: 'MultiLineString', coordinates: valid };
}
function circle(center, radiusKm, samples = 96) {
  const angular = radiusKm / R, lat = center.lat * RAD, lng = center.lng * RAD;
  const coordinates = [];
  for (let i = 0; i <= samples; i++) {
    const bearing = (i / samples) * 2 * Math.PI;
    const nextLat = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
    const nextLng = lng + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(nextLat));
    coordinates.push([wrapLng(nextLng / RAD), nextLat / RAD]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}
function point(place, properties = {}) {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [place.lng, place.lat] } };
}
function line(path, progress, properties = {}) {
  return { type: 'Feature', properties, geometry: lineGeometry(slicePath(path, progress)) };
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
/** The shared clock stores accumulated elapsedMs plus the time since its last start. */
export function timelineElapsedMs(clock = {}, now = Date.now()) {
  const elapsed = Math.max(0, Number(clock.elapsedMs) || 0);
  const started = timestamp(clock.startedAt);
  const duration = Number(clock.durationMs) || Infinity;
  const hasStart = clock.startedAt !== null && clock.startedAt !== undefined &&
    (typeof clock.startedAt === 'number' ? Number.isFinite(clock.startedAt) : Number.isFinite(Date.parse(clock.startedAt)));
  return clamp(elapsed + (!clock.paused && hasStart ? Math.max(0, now - started) : 0), 0, duration);
}

/** One camera rise, then one arrival. Defaults preserve the five-second halves. */
export function breathPosition(elapsed, duration, inhaleMs = 5000, exhaleMs = 5000) {
  const cycleMs = Math.max(1, inhaleMs + exhaleMs);
  const cycles = Math.max(1, Math.round(duration / cycleMs));
  // Exact defaults use 10-second cycles. A deliberately changed duration scales
  // both halves together, so the final group is never left unfinished.
  const cycleDuration = Math.max(1, duration / cycles);
  const time = clamp(elapsed, 0, duration);
  const completed = time >= duration;
  const index = completed ? cycles - 1 : Math.min(cycles - 1, Math.floor(time / cycleDuration));
  const within = completed ? cycleMs : (time - index * cycleDuration) / cycleDuration * cycleMs;
  return {
    index, cycles,
    rise: clamp(within / Math.max(1, inhaleMs), 0, 1),
    arrival: clamp((within - inhaleMs) / Math.max(1, exhaleMs), 0, 1),
  };
}
function timeout(promise, duration, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), duration);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function loadStylesheet() {
  if (!cssPromise) cssPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('link[data-offering-maplibre]');
    if (existing?.sheet) { resolve(); return; }
    const link = existing || document.createElement('link');
    link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS; link.dataset.offeringMaplibre = MAPLIBRE_VERSION;
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => { link.remove(); reject(new Error('Map styles could not load.')); }, { once: true });
    if (!existing) document.head.append(link);
  }).catch(error => { cssPromise = null; throw error; });
  return cssPromise;
}
async function loadLibrary() {
  if (!libraryPromise) libraryPromise = import(MAPLIBRE_MODULE).catch(error => { libraryPromise = null; throw error; });
  const [library] = await timeout(Promise.all([libraryPromise, loadStylesheet()]), LOAD_TIMEOUT_MS, 'The map library took too long to load.');
  // MapLibre v6 discovers its sibling worker from this CDN module URL and
  // wraps it in a same-origin Blob. The Vite ?worker&url import is not needed
  // on this unbundled page. See the official installation guide, CDN tab.
  if (typeof library.Map !== 'function') throw new Error('The map library did not expose its Map constructor.');
  return library;
}
function motionPreference() {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
}

function createSurface(container, { config, interactive, onStatus, onReady, onDispose, onUnavailable }) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) throw new Error('A map container is required.');
  root.classList.add('offering-map-root', interactive ? 'offering-map--selection' : 'offering-map--presentation');
  const canvas = document.createElement('div'); canvas.className = 'offering-map-canvas';
  const message = document.createElement('div'); message.className = 'offering-map-message'; message.setAttribute('role', 'status');
  const heading = document.createElement('p'); heading.className = 'offering-map-message-title';
  const detail = document.createElement('p'); detail.className = 'offering-map-message-detail';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'offering-map-retry'; retry.textContent = 'Try map again'; retry.hidden = true;
  message.append(heading, detail, retry); root.append(canvas, message);
  let map = null, library = null, destroyed = false, generation = 0, ready = false;
  let loadTimer = null, resourceWarnings = 0;
  const diagnose = (stage, error) => {
    // Never log map state, participant records, credentials, or entire error objects.
    const message = String(error?.message || error || 'Unknown map error')
      .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[redacted]')
      .slice(0, 500);
    console.warn(`[Offering map] ${stage}: ${message}`);
  };
  const notify = (text, state, available = false) => {
    try { onStatus?.(text, { state, available, ready: state === 'ready' }); } catch { /* An external status view cannot break the map. */ }
  };
  const fail = (error) => {
    if (destroyed) return;
    if (error) diagnose('unavailable', error);
    ready = false; clearTimeout(loadTimer); onDispose?.();
    if (map) { try { map.remove(); } catch {} map = null; }
    if (onUnavailable) {
      // The public facade replaces this surface with a map that does not need
      // WebGL. Do not tell participants to leave their browser in the meantime.
      heading.textContent = 'Opening the map…'; detail.textContent = '';
      retry.hidden = true; message.hidden = false;
      root.classList.remove('offering-map--unavailable');
      onUnavailable(error);
      return;
    }
    const reason = String(error?.message || error || '');
    const rendererUnavailable = /webgl|gpu|graphics context|map renderer/i.test(reason);
    const resourceUnavailable = /fetch|network|could not load|failed to load|took too long|finish loading/i.test(reason);
    heading.textContent = 'Map unavailable';
    if (rendererUnavailable) {
      detail.textContent = interactive
        ? 'Use search, or try a browser with WebGL2 graphics.'
        : 'The places remain listed. Try a browser with WebGL2 graphics for the map.';
    } else if (resourceUnavailable) {
      detail.textContent = interactive
        ? 'Use search, or check the connection and retry.'
        : 'The places remain listed. Check the connection and retry.';
    } else {
      detail.textContent = interactive
        ? 'Use search, or retry the map.'
        : 'The places remain listed. You can retry the map.';
    }
    retry.hidden = false; message.hidden = false; root.classList.add('offering-map--unavailable');
    const status = rendererUnavailable ? 'Map unavailable in this browser (WebGL2).' : 'Map unavailable.';
    notify(status + (interactive ? ' Search remains available.' : ' The place list remains available.'), 'unavailable', false);
  };
  const start = async () => {
    if (destroyed) return;
    const ownGeneration = ++generation;
    if (map) { onDispose?.(); map.remove(); map = null; }
    ready = false; resourceWarnings = 0; clearTimeout(loadTimer); retry.hidden = true; message.hidden = false;
    heading.textContent = 'Opening the map…'; detail.textContent = '';
    root.classList.remove('offering-map--unavailable'); notify('Loading the map…', 'loading', false);
    try {
      library = await loadLibrary();
      if (destroyed || ownGeneration !== generation) return;
      if (library.supported && !library.supported()) { fail(new Error('This browser cannot use the WebGL2 map renderer.')); return; }
      map = new library.Map({
        container: canvas, style: MAP_STYLE,
        center: [config.center.lng, config.center.lat], zoom: interactive ? 12 : 16.4,
        pitch: interactive ? 0 : 54, bearing: interactive ? 0 : -24,
        interactive, attributionControl: false, maxZoom: 19,
        renderWorldCopies: true, fadeDuration: 180,
        canvasContextAttributes: { antialias: true },
      });
      map.addControl(new library.AttributionControl({
        compact: false,
        customAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>',
      }), 'bottom-right');
      if (interactive) map.addControl(new library.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
      const mapCanvas = map.getCanvas();
      mapCanvas.setAttribute('aria-label', interactive
        ? 'Geographic place selector. Pan with arrow keys and use the Choose map center button, or use Search.'
        : 'Shared geographic view. A text list of contributions is available in the presenter page.');
      map.on('error', event => {
        if (resourceWarnings++ < 3) diagnose('resource', event.error);
        // A single missing tile is recoverable. The style-load deadline handles a failed basemap.
        if (!ready && !destroyed) detail.textContent = interactive
          ? 'Map data is taking longer to arrive. Search remains available.'
          : 'Map data is taking longer to arrive. The place list remains available.';
      });
      map.once('load', () => {
        if (destroyed || ownGeneration !== generation || !map) return;
        clearTimeout(loadTimer);
        try {
          ready = true;
          onReady(map, library);
          message.hidden = true; root.classList.remove('offering-map--unavailable'); notify('', 'ready', true);
        } catch (error) { fail(error); }
      });
      loadTimer = setTimeout(() => {
        if (!ready && ownGeneration === generation) fail(new Error('The basemap did not finish loading within 16 seconds.'));
      }, LOAD_TIMEOUT_MS);
    } catch (error) { if (ownGeneration === generation) fail(error); }
  };
  retry.addEventListener('click', start);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (map && ready) map.resize(); }) : null;
  observer?.observe(root);
  return {
    start,
    get map() { return ready ? map : null; },
    get root() { return root; },
    notify,
    resize() { map?.resize(); },
    destroy() {
      destroyed = true; generation++; clearTimeout(loadTimer); observer?.disconnect(); onDispose?.();
      retry.removeEventListener('click', start); map?.remove(); map = null;
      canvas.remove(); message.remove();
    },
  };
}

function tintBasemap(map) {
  for (const layer of map.getStyle().layers || []) {
    try {
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#f2edf5');
      else if (layer.type === 'fill' && /^water($|_)/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#dbe1ef');
      else if (layer.type === 'fill' && /building/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#e0d5e7');
    } catch { /* Retain the provider's style if a layer is expression constrained. */ }
  }
}
function addSelectionLayers(map, config) {
  map.addSource('offering-boundary', { type: 'geojson', data: collection([circle(config.center, config.radiusKm)]) });
  map.addLayer({ id: 'offering-boundary-fill', type: 'fill', source: 'offering-boundary', paint: { 'fill-color': COLORS.ring, 'fill-opacity': 0.035 } });
  map.addLayer({ id: 'offering-boundary-line', type: 'line', source: 'offering-boundary', paint: { 'line-color': COLORS.line, 'line-width': 1.5, 'line-dasharray': [4, 4], 'line-opacity': 0.55 } });
}

async function createSelectionMap3D(container, { config: rawConfig = {}, round: initialRound = 'local', onSelect, onStatus, onUnavailable } = {}) {
  const config = settings(rawConfig), preference = motionPreference();
  let round = ['hometown', 'global', 'home'].includes(initialRound) ? 'hometown' : 'local';
  let selection = null, marker = null, centerButton = null;
  const surface = createSurface(container, {
    config, interactive: true, onStatus, onUnavailable,
    onDispose() { marker = null; },
    onReady(map, library) {
      tintBasemap(map); addSelectionLayers(map, config);
      map.getCanvas().style.cursor = 'crosshair';
      map.on('click', event => select({ lat: event.lngLat.lat, lng: wrapLng(event.lngLat.lng), label: 'Selected place', kind: 'place' }));
      applyRound(false);
      if (selection) drawSelection(library);
    },
  });
  centerButton = document.createElement('button'); centerButton.type = 'button'; centerButton.className = 'offering-map-center-button';
  centerButton.textContent = 'Choose map center'; centerButton.setAttribute('aria-label', 'Choose the location at the center of the map');
  centerButton.addEventListener('click', () => {
    const center = surface.map?.getCenter();
    if (center) select({ lat: center.lat, lng: wrapLng(center.lng), label: 'Selected place', kind: 'place' });
  });
  surface.root.append(centerButton);
  function select(place) {
    if (round === 'local' && distanceKm(config.center, place) > config.radiusKm) {
      surface.notify(`Choose a nearby place within ${Math.round(config.radiusKm / 1.609344)} miles of the class starting point.`, 'selection-error', true);
      return;
    }
    selection = cleanPlace(place);
    drawSelection();
    surface.notify('', 'ready', true);
    onSelect?.({ ...selection });
  }
  function drawSelection(library) {
    const map = surface.map;
    if (!map || !selection) return;
    const lib = library || mapLibrary;
    if (!lib) return;
    if (!marker) {
      const dot = document.createElement('div'); dot.className = 'offering-selection-marker';
      dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Your selected location');
      marker = new lib.Marker({ element: dot, anchor: 'center' }).setLngLat([selection.lng, selection.lat]).addTo(map);
    } else marker.setLngLat([selection.lng, selection.lat]);
  }
  let mapLibrary;
  // Retrieve the same cached module so setSelection can update its marker after initialization.
  loadLibrary().then(lib => { mapLibrary = lib; }).catch(() => {});
  function applyRound(animate = true) {
    const map = surface.map;
    if (!map) return;
    const local = round === 'local';
    for (const layer of ['offering-boundary-fill', 'offering-boundary-line']) map.setLayoutProperty(layer, 'visibility', local ? 'visible' : 'none');
    const pose = { center: local ? [config.center.lng, config.center.lat] : [0, 20], zoom: local ? 12 : 1, pitch: 0, bearing: 0 };
    if (animate && !preference.matches) map.easeTo({ ...pose, duration: 850, essential: false }); else map.jumpTo(pose);
  }
  await surface.start();
  return {
    setRound(nextRound) {
      const next = nextRound === 'hometown' || nextRound === 'global' || nextRound === 'home' ? 'hometown' : 'local';
      if (next === round) return;
      round = next; selection = null; marker?.remove(); marker = null; applyRound();
    },
    setSelection(place) {
      selection = cleanPlace(place);
      if (!selection) { marker?.remove(); marker = null; return; }
      drawSelection();
      const map = surface.map;
      if (!map) return;
      const pose = { center: [selection.lng, clamp(selection.lat, -85, 85)], zoom: round === 'local' ? Math.max(12, map.getZoom()) : 7 };
      if (preference.matches) map.jumpTo(pose); else map.easeTo({ ...pose, duration: 850, essential: false });
    },
    resize: () => surface.resize(),
    destroy() { marker?.remove(); centerButton.remove(); surface.destroy(); },
  };
}

function normalizedEntries(state) {
  const raw = state?.entries || [];
  const records = Array.isArray(raw) ? raw : [
    ...(Array.isArray(raw.local) ? raw.local.map(entry => ({ ...entry, round: 'local' })) : []),
    ...(Array.isArray(raw.hometown) ? raw.hometown.map(entry => ({ ...entry, round: 'hometown' })) : []),
  ];
  const result = { local: [], hometown: [] };
  records.forEach((entry, index) => {
    const who = entry.anonymous ? '' : String(entry.displayName || entry.who || entry.name || '').slice(0, 60);
    const id = String(entry.id || entry.participantId || index);
    const add = (round, place) => {
      const clean = cleanPlace(place);
      if (!clean) return;
      result[round].push({ ...clean, id: `${id}-${round}`, who });
    };
    if (entry.local || entry.localPlace) add('local', entry.local || entry.localPlace);
    if (entry.hometown || entry.hometownPlace) add('hometown', entry.hometown || entry.hometownPlace);
    if (entry.round || entry.phase) {
      const round = entry.round || entry.phase;
      add(round === 'home' || round === 'hometown' ? 'hometown' : 'local', entry.place && typeof entry.place === 'object' ? entry.place : entry);
    }
  });
  return result;
}
function groupedPins(places) {
  const groups = new Map();
  for (const place of places) {
    const key = `${place.lat.toFixed(5)},${place.lng.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(place);
  }
  return [...groups.values()].map(group => {
    const p = group[0];
    const label = group.length > 1 ? `${p.label}\n${group.length} contributions` : `${p.label}${p.who ? `\n${p.who}` : ''}`;
    return point(p, { label, count: group.length });
  });
}
function addBuildings(map) {
  const style = map.getStyle();
  if (style.layers?.some(layer => layer.type === 'fill-extrusion')) return;
  const building = style.layers?.find(layer => layer['source-layer'] === 'building' && layer.source && style.sources?.[layer.source]?.type === 'vector');
  if (!building) return;
  const before = style.layers.find(layer => layer.type === 'symbol')?.id;
  try {
    map.addLayer({
      id: 'offering-buildings', type: 'fill-extrusion', source: building.source, 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-color': '#cfc0dc',
        'fill-extrusion-height': ['max', 0, ['to-number', ['get', 'render_height'], ['get', 'height'], 0]],
        'fill-extrusion-base': ['max', 0, ['to-number', ['get', 'render_min_height'], ['get', 'min_height'], 0]],
        'fill-extrusion-opacity': 0.66,
      },
    }, before);
  } catch { /* Building heights are optional data. The geographic map remains available. */ }
}
function addPresentationLayers(map, config) {
  tintBasemap(map); addBuildings(map);
  for (const id of ['threads', 'pins', 'origin', 'ring']) map.addSource(`offering-${id}`, { type: 'geojson', data: EMPTY() });
  map.addLayer({ id: 'offering-ring', type: 'line', source: 'offering-ring', paint: { 'line-color': COLORS.ring, 'line-width': 1, 'line-opacity': 0.23 } });
  map.addLayer({ id: 'offering-thread-halo', type: 'line', source: 'offering-threads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.halo, 'line-width': 8, 'line-blur': 4, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'offering-thread', type: 'line', source: 'offering-threads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.line, 'line-width': 2.8, 'line-opacity': 0.86 } });
  map.addLayer({ id: 'offering-pin-halo', type: 'circle', source: 'offering-pins', paint: { 'circle-color': COLORS.halo, 'circle-radius': 14, 'circle-opacity': 0.4, 'circle-blur': 0.8 } });
  map.addLayer({ id: 'offering-pin', type: 'circle', source: 'offering-pins', paint: { 'circle-color': COLORS.pin, 'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 5, 5, 8], 'circle-stroke-color': '#fffafc', 'circle-stroke-width': 1.5 } });
  const font = (map.getStyle().layers || []).map(layer => layer.layout?.['text-font']).find(value => Array.isArray(value) && value.every(item => typeof item === 'string') && !['case', 'coalesce', 'match'].includes(value[0])) || ['Noto Sans Regular'];
  map.addLayer({ id: 'offering-pin-label', type: 'symbol', source: 'offering-pins', layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12, 'text-offset': [0, 1.05], 'text-anchor': 'top', 'text-max-width': 14, 'text-line-height': 1.25 }, paint: { 'text-color': '#503a59', 'text-halo-color': '#fffafd', 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'offering-origin-halo', type: 'circle', source: 'offering-origin', paint: { 'circle-color': '#d7c4e5', 'circle-radius': 19, 'circle-opacity': 0.48, 'circle-blur': 0.65 } });
  map.addLayer({ id: 'offering-origin', type: 'circle', source: 'offering-origin', paint: { 'circle-color': COLORS.center, 'circle-radius': 6, 'circle-stroke-color': '#fffafc', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'offering-origin-label', type: 'symbol', source: 'offering-origin', layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-max-width': 18 }, paint: { 'text-color': '#503a59', 'text-halo-color': '#fffafd', 'text-halo-width': 1.6 } });
  map.getSource('offering-origin').setData(collection([point(config.center, { label: config.center.label })]));
}
function radiusPose(map, config, radius, pitch = 0) {
  const latDelta = radius / 110.574;
  const lngDelta = radius / Math.max(1, 111.32 * Math.cos(config.center.lat * RAD));
  let zoom = clamp(14.2 - Math.log2(Math.max(0.15, radius)), 6.5, 16.4);
  try {
    const height = map.getContainer().clientHeight, width = map.getContainer().clientWidth;
    const camera = map.cameraForBounds([
      [config.center.lng - lngDelta, clamp(config.center.lat - latDelta, -85, 85)],
      [config.center.lng + lngDelta, clamp(config.center.lat + latDelta, -85, 85)],
    ], { padding: Math.min(100, Math.max(30, Math.min(width, height) * 0.12)), maxZoom: 16.4, bearing: -24, pitch });
    if (camera) zoom = camera.zoom;
  } catch {}
  return { center: [config.center.lng, config.center.lat], zoom, pitch, bearing: -24 };
}
function interpolatePose(a, b, p) {
  return { center: [shortestLng(a.center[0], b.center[0], p), mix(a.center[1], b.center[1], p)], zoom: mix(a.zoom, b.zoom, p), pitch: mix(a.pitch || 0, b.pitch || 0, p), bearing: mix(a.bearing || 0, b.bearing || 0, p) };
}
function hometownPose(center, place) {
  const midpoint = greatCirclePath(center, place, 2)[1];
  const degrees = distanceKm(center, place) / R / RAD;
  return { center: [midpoint[0], clamp(midpoint[1], -65, 65)], zoom: clamp(2.6 - Math.log2(Math.max(10, degrees) / 30), 0.5, 3.6), pitch: 0, bearing: 0 };
}
function hometownGroupPose(map, center, places, paths, maxZoom) {
  if (!places.length) return { center: [center.lng, center.lat], zoom: maxZoom, pitch: 0, bearing: 0 };
  const fallback = hometownPose(center, places.at(-1));
  try {
    // Include the complete arcs already offered, not just the next destination.
    // Unwrap around the room so a date-line crossing does not fit the long way.
    const coordinates = [[center.lng, center.lat], ...places.flatMap(place => paths.get(place.id) || [[place.lng, place.lat]])];
    const longitudes = coordinates.map(p => center.lng + wrapLng(p[0] - center.lng));
    const latitudes = coordinates.map(p => clamp(p[1], -85, 85));
    const container = map.getContainer();
    const padding = Math.min(90, Math.max(24, Math.min(container.clientWidth, container.clientHeight) * 0.13));
    const fitted = map.cameraForBounds([
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ], { padding, maxZoom, pitch: 0, bearing: 0 });
    const at = fitted?.center;
    const lng = Array.isArray(at) ? at[0] : at?.lng;
    const lat = Array.isArray(at) ? at[1] : at?.lat;
    if (Number.isFinite(fitted?.zoom) && Number.isFinite(lng) && Number.isFinite(lat)) {
      return { center: [lng, lat], zoom: Math.min(maxZoom, fitted.zoom), pitch: 0, bearing: 0 };
    }
  } catch { /* A device/projection can fall back to a conservative geographic pose. */ }
  return { ...fallback, zoom: Math.min(maxZoom, fallback.zoom) };
}
function globalCenter(center, homes) {
  const points = [center, ...homes];
  const vector = points.reduce((sum, p) => {
    sum[0] += Math.cos(p.lat * RAD) * Math.cos(p.lng * RAD);
    sum[1] += Math.cos(p.lat * RAD) * Math.sin(p.lng * RAD);
    sum[2] += Math.sin(p.lat * RAD); return sum;
  }, [0, 0, 0]);
  if (Math.hypot(...vector) < 0.00001) return [center.lng, 20];
  return [Math.atan2(vector[1], vector[0]) / RAD, clamp(Math.atan2(vector[2], Math.hypot(vector[0], vector[1])) / RAD, -55, 55)];
}

async function createPresentationMap3D(container, { config: rawConfig = {}, onStatus, onUnavailable } = {}) {
  const config = settings(rawConfig), preference = motionPreference();
  let state = { phase: 'local_open', entries: [], clock: {} };
  let entries = { local: [], hometown: [] }, signature = '', paths = new Map();
  let raf = 0, lastDraw = -Infinity, previousPhase = '', phaseEnteredAt = Date.now();
  let serverOffset = 0, projection = 'mercator', globeSupported = true;
  let completePose = null, restFromPose = null, manualFreeze = null, localPauseStart = null;
  let baseLabels = [], baseLabelsHidden = null, homePoseCache = null;
  let lastSceneKey = '';
  const surface = createSurface(container, {
    config, interactive: false, onStatus, onUnavailable,
    onDispose() { cancelAnimationFrame(raf); raf = 0; lastSceneKey = ''; homePoseCache = null; },
    onReady(map) {
      baseLabels = (map.getStyle().layers || []).filter(layer => layer.type === 'symbol' && layer.layout?.['text-field'])
        .map(layer => ({ id: layer.id, opacity: layer.paint?.['text-opacity'] ?? null }));
      baseLabelsHidden = null;
      addPresentationLayers(map, config); projection = 'mercator'; render(Date.now(), true); schedule();
    },
  });
  function setBasemapLabels(hidden) {
    const map = surface.map;
    if (!map || hidden === baseLabelsHidden) return;
    baseLabelsHidden = hidden;
    for (const layer of baseLabels) {
      try {
        map.setPaintProperty(layer.id, 'text-opacity-transition', { duration: preference.matches ? 0 : 1200 });
        map.setPaintProperty(layer.id, 'text-opacity', hidden ? 0 : layer.opacity);
      } catch { /* Keep the map usable when a provider changes a label layer. */ }
    }
  }
  function setProjection(globe) {
    const map = surface.map, next = globe && globeSupported ? 'globe' : 'mercator';
    if (!map || next === projection) return;
    try { map.setProjection({ type: next }); projection = next; }
    catch { globeSupported = false; projection = 'mercator'; surface.notify('Using the flat world map on this device.', 'notice', true); }
  }
  function camera(pose) {
    const map = surface.map;
    if (!map || !pose) return;
    map.jumpTo({ ...pose, center: [wrapLng(pose.center[0]), clamp(pose.center[1], -80, 80)] });
  }
  function currentPose() {
    const map = surface.map;
    if (!map) return { center: [config.center.lng, config.center.lat], zoom: 16.4, pitch: 54, bearing: -24 };
    const c = map.getCenter(); return { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  }
  function refreshEntries() {
    const next = normalizedEntries(state);
    const nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return;
    signature = nextSignature;
    for (const round of ['local', 'hometown']) next[round].sort((a, b) => distanceKm(config.center, a) - distanceKm(config.center, b) || a.id.localeCompare(b.id));
    entries = next; paths = new Map(); homePoseCache = null;
    for (const p of [...entries.local, ...entries.hometown]) paths.set(p.id, greatCirclePath(config.center, p, p.id.endsWith('local') ? 28 : 96));
    lastSceneKey = '';
  }
  function drawScene(threads, pins, ringRadius, originLabel, key) {
    const map = surface.map;
    if (!map || key === lastSceneKey) return;
    lastSceneKey = key;
    map.getSource('offering-threads')?.setData(collection(threads));
    map.getSource('offering-pins')?.setData(collection(groupedPins(pins)));
    map.getSource('offering-ring')?.setData(ringRadius > 0 ? collection([circle(config.center, ringRadius)]) : EMPTY());
    map.getSource('offering-origin')?.setData(collection([point(config.center, { label: originLabel })]));
  }
  function localScene(elapsed, complete = false, shrink = 1) {
    const map = surface.map;
    const breath = breathPosition(complete ? config.localDurationMs : elapsed, config.localDurationMs, config.inhaleMs, config.exhaleMs);
    const cycles = breath.cycles;
    const radius = Math.max(0.8, ...entries.local.map(p => distanceKm(config.center, p))) * 1.12;
    const ring = breath.index;
    const nextRadius = radius * (ring + 1) / cycles;
    const previousRadius = radius * ring / cycles;
    const reveal = breath.arrival;
    const threadProgress = preference.matches ? (reveal >= 1 ? 1 : 0) : smooth(reveal);
    const threads = [], pins = [];
    for (const p of entries.local) {
      const d = distanceKm(config.center, p);
      const belongsTo = Math.min(cycles - 1, Math.floor(d / radius * cycles));
      const f = complete || belongsTo < ring ? 1 : belongsTo === ring ? threadProgress : 0;
      if (f > 0) threads.push(line(paths.get(p.id), f * shrink));
      if (f >= 0.999 && shrink >= 0.999) pins.push(p);
    }
    const start = ring === 0 ? { center: [config.center.lng, config.center.lat], zoom: 16.4, pitch: 54, bearing: -24 } : radiusPose(map, config, previousRadius);
    const end = radiusPose(map, config, nextRadius);
    const rise = preference.matches ? (breath.rise >= 1 ? 1 : 0) : smooth(breath.rise);
    return { threads, pins, pose: interpolatePose(start, end, rise), radius: complete ? 0 : nextRadius };
  }
  function hometownPoses(cycles) {
    const map = surface.map, container = map.getContainer();
    const key = `${cycles}:${projection}:${container.clientWidth}:${container.clientHeight}:${signature}`;
    if (homePoseCache?.key === key) return homePoseCache.poses;
    const poses = [];
    let maxZoom = 4.5;
    for (let group = 0; group < cycles; group++) {
      const shown = entries.hometown.filter((_, index) => Math.floor(index * cycles / Math.max(1, entries.hometown.length)) <= group);
      const pose = hometownGroupPose(map, config.center, shown, paths, maxZoom);
      maxZoom = pose.zoom; poses.push(pose);
    }
    homePoseCache = { key, poses }; return poses;
  }
  function render(now, force = false) {
    const map = surface.map;
    if (!map) return;
    const at = manualFreeze ?? now;
    const phase = state.phase || 'local_open';
    const clock = state.clock || {};
    const elapsed = timelineElapsedMs(clock, at + serverOffset);
    const reduced = preference.matches;
    setBasemapLabels(phase === 'hometown_reveal' || phase === 'hometown_rest' || phase === 'complete');
    let threads = [], pins = [], ringRadius = 0, originLabel = config.center.label;
    let pose;
    if (phase === 'local_open') {
      setProjection(false);
      pose = { center: [config.center.lng, config.center.lat], zoom: 16.4, pitch: 54, bearing: -24 };
    } else if (phase === 'local_reveal') {
      setProjection(false);
      const scene = localScene(Math.min(elapsed, config.localDurationMs));
      ({ threads, pins, pose } = scene); ringRadius = scene.radius;
    } else if (phase === 'local_rest' || phase === 'hometown_open') {
      setProjection(false);
      ({ threads, pins, pose } = localScene(config.localDurationMs, true));
    } else if (phase === 'hometown_reveal') {
      const totalDuration = Number(clock.durationMs) || config.hometownDurationMs;
      const collapseMs = Math.min(config.inhaleMs + config.exhaleMs, totalDuration / 3);
      originLabel = 'Syracuse';
      if (elapsed < collapseMs) {
        setProjection(false);
        const progress = reduced ? (elapsed >= collapseMs ? 1 : 0) : smooth(elapsed / collapseMs);
        const scene = localScene(config.localDurationMs, true, 1 - progress);
        threads = scene.threads; pins = progress === 0 ? scene.pins : [];
        pose = interpolatePose(scene.pose, { center: [config.center.lng, config.center.lat], zoom: 4.5, pitch: 0, bearing: 0 }, progress);
      } else {
        setProjection(true);
        const duration = Math.max(1, totalDuration - collapseMs);
        const breath = breathPosition(elapsed - collapseMs, duration, config.inhaleMs, config.exhaleMs);
        const count = entries.hometown.length;
        entries.hometown.forEach((p, i) => {
          const group = Math.min(breath.cycles - 1, Math.floor(i * breath.cycles / Math.max(1, count)));
          const raw = group < breath.index ? 1 : group === breath.index ? breath.arrival : 0;
          const f = reduced ? (raw >= 1 ? 1 : 0) : smooth(raw);
          if (f > 0) threads.push(line(paths.get(p.id), f));
          if (f >= 0.999) pins.push(p);
        });
        const poses = hometownPoses(breath.cycles);
        const start = breath.index > 0 ? poses[breath.index - 1] : { center: [config.center.lng, config.center.lat], zoom: 4.5, pitch: 0, bearing: 0 };
        pose = interpolatePose(start, poses[breath.index], reduced ? (breath.rise >= 1 ? 1 : 0) : smooth(breath.rise));
      }
    } else {
      setProjection(true); originLabel = 'Syracuse';
      for (const p of entries.hometown) { threads.push(line(paths.get(p.id), 1)); pins.push(p); }
      if (phase === 'complete' && completePose) pose = completePose;
      else {
        const center = globalCenter(config.center, entries.hometown);
        const since = Math.max(0, at - phaseEnteredAt);
        const rotating = phase === 'hometown_rest' && config.globeRotation !== false && !reduced && !manualFreeze;
        const turn = rotating ? Math.max(0, since - 4000) / 1000 * 0.8 : 0;
        const target = { center: [center[0] + turn, center[1]], zoom: 0.75, pitch: 0, bearing: 0 };
        pose = phase === 'complete' || reduced || !restFromPose ? target : interpolatePose(restFromPose, target, smooth(since / 4000));
      }
    }
    const bucket = Math.floor(elapsed / (reduced ? 250 : 50));
    const key = `${phase}:${bucket}:${signature}:${threads.length}:${pins.length}:${force ? now : ''}`;
    drawScene(threads, pins, ringRadius, originLabel, key);
    camera(pose);
  }
  function animating() {
    const phase = state.phase || 'local_open';
    if (manualFreeze || document.hidden) return false;
    if (phase === 'local_reveal' || phase === 'hometown_reveal') return !state.clock?.paused;
    return phase === 'hometown_rest' && ((!preference.matches && config.globeRotation !== false) || Date.now() - phaseEnteredAt < 4000);
  }
  function schedule() {
    if (raf || !surface.map || !animating()) return;
    raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = 0;
    if (now - lastDraw >= (preference.matches ? 250 : 50)) { lastDraw = now; render(Date.now()); }
    schedule();
  }
  function onMotionChange() { lastSceneKey = ''; render(Date.now(), true); schedule(); }
  function onVisibility() {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else { render(Date.now(), true); schedule(); }
  }
  preference.addEventListener?.('change', onMotionChange);
  document.addEventListener('visibilitychange', onVisibility);
  await surface.start();
  return {
    update(nextState) {
      if (!nextState || typeof nextState !== 'object') return;
      const nextPhase = nextState.phase || 'local_open';
      if (nextPhase !== previousPhase) {
        phaseEnteredAt = Date.now(); restFromPose = currentPose();
        completePose = nextPhase === 'complete' && previousPhase && surface.map ? currentPose() : null;
        previousPhase = nextPhase; lastSceneKey = '';
      }
      const serverNow = timestamp(nextState.serverTime || nextState.serverNow);
      if (serverNow) serverOffset = serverNow - Date.now();
      state = nextState; refreshEntries(); render(Date.now(), true);
      if (!animating()) { cancelAnimationFrame(raf); raf = 0; } else schedule();
    },
    // A local visual pause; global pause/resume comes from the server's shared clock in update().
    pause(paused = true) {
      if (paused && manualFreeze == null) { manualFreeze = Date.now(); localPauseStart = manualFreeze; }
      else if (!paused && manualFreeze != null) { phaseEnteredAt += Date.now() - localPauseStart; manualFreeze = null; localPauseStart = null; }
      render(Date.now(), true);
      if (paused) { cancelAnimationFrame(raf); raf = 0; } else schedule();
    },
    resize() { surface.resize(); lastSceneKey = ''; render(Date.now(), true); },
    destroy() {
      cancelAnimationFrame(raf); preference.removeEventListener?.('change', onMotionChange);
      document.removeEventListener('visibilitychange', onVisibility); surface.destroy();
    },
  };
}

/**
 * Keep the same page API while changing renderer. In particular, the caller can
 * change rounds or receive a room update while either map library is loading.
 * The previous map's canvas, observers, event handlers and animation are removed
 * before the flat map starts; the selected place and shared clock are retained.
 */
function resilientMap(container, options, create3D, fallbackExport, restore) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) throw new Error('A map container is required.');
  let active = null, initializing3D = true, fallbackRequested = false;
  let fallbackStarted = false, destroyed = false, fallbackError = null;
  const notify = (message, detail) => {
    if (destroyed) return;
    try { options.onStatus?.(message, detail); } catch { /* Status is an optional view. */ }
  };
  function dispose(instance) {
    try { instance?.destroy?.(); } catch { /* Finish replacing an incomplete renderer. */ }
  }
  function requestFallback() {
    if (destroyed || fallbackRequested) return;
    fallbackRequested = true;
    notify('Opening the map…', { state: 'loading', available: false, ready: false, renderer: '2d' });
    // A constructor can fail before its asynchronous factory has returned its
    // cleanup handle. Wait for that handle instead of leaving its DOM behind.
    if (!initializing3D) void startFallback();
  }
  function showFallbackError() {
    fallbackError?.remove();
    const message = document.createElement('div'); message.className = 'offering-map-message'; message.setAttribute('role', 'status');
    const title = document.createElement('p'); title.className = 'offering-map-message-title'; title.textContent = 'Map unavailable';
    const detail = document.createElement('p'); detail.className = 'offering-map-message-detail';
    detail.textContent = fallbackExport === 'createSelectionMap2D' ? 'Use search, or retry the map.' : 'The places remain listed. You can retry the map.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'offering-map-retry'; retry.textContent = 'Try map again';
    retry.addEventListener('click', () => { if (!destroyed) void startFallback(); });
    message.append(title, detail, retry); root.append(message); fallbackError = message;
    notify('Map unavailable.' + (fallbackExport === 'createSelectionMap2D' ? ' Search remains available.' : ' The place list remains available.'),
      { state: 'unavailable', available: false, ready: false, renderer: '2d' });
  }
  async function startFallback() {
    if (destroyed || fallbackStarted) return;
    fallbackStarted = true;
    dispose(active); active = null;
    fallbackError?.remove(); fallbackError = null;
    root.classList.remove('offering-map--unavailable');
    notify('Opening the map…', { state: 'loading', available: false, ready: false, renderer: '2d' });
    try {
      const module = await import('./map2d.js');
      if (destroyed) return;
      const next = await module[fallbackExport](root, { ...options, onStatus: notify });
      if (destroyed) { dispose(next); return; }
      active = next;
      restore(active);
      active.resize?.();
    } catch {
      if (destroyed) return;
      dispose(active); active = null;
      fallbackStarted = false;
      showFallbackError();
    }
  }
  async function start() {
    let next = null;
    try {
      next = await create3D(root, {
        ...options,
        onUnavailable: requestFallback,
        onStatus(message, detail) {
          if (!fallbackRequested) notify(message, { ...detail, renderer: '3d' });
        },
      });
    } catch { requestFallback(); }
    initializing3D = false;
    if (destroyed) { dispose(next); return; }
    if (fallbackRequested) { dispose(next); await startFallback(); return; }
    active = next;
    try { restore(active); } catch { requestFallback(); }
  }
  return {
    start,
    call(method, ...args) {
      if (destroyed || !active) return;
      try { active[method]?.(...args); }
      catch {
        if (!fallbackRequested) requestFallback();
        else notify('Map unavailable. The place list remains available.', { state: 'unavailable', available: false, ready: false, renderer: '2d' });
      }
    },
    destroy() {
      destroyed = true;
      dispose(active); active = null;
      fallbackError?.remove(); fallbackError = null;
    },
  };
}

/** Interactive map, with a compatible flat map on devices without WebGL2. */
export async function createSelectionMap(container, options = {}) {
  const normalizedRound = value => ['hometown', 'global', 'home'].includes(value) ? 'hometown' : 'local';
  let round = normalizedRound(options.round), selection = null;
  const rendererOptions = {
    ...options, round,
    onSelect(place) { selection = cleanPlace(place); options.onSelect?.(place); },
  };
  const surface = resilientMap(container, rendererOptions, createSelectionMap3D, 'createSelectionMap2D', map => {
    map.setRound?.(round); map.setSelection?.(selection);
  });
  const setSelection = place => { selection = cleanPlace(place); surface.call('setSelection', selection); };
  void surface.start();
  return {
    setRound(next) {
      const value = normalizedRound(next);
      if (value === round) return;
      round = value; rendererOptions.round = round; selection = null; surface.call('setRound', round);
    },
    setSelection,
    setPlace: setSelection,
    resize: () => surface.call('resize'),
    destroy: () => surface.destroy(),
  };
}

/** Shared presentation, preserving the server clock across renderer fallback. */
export async function createPresentationMap(container, options = {}) {
  let state = null, paused = false;
  const surface = resilientMap(container, options, createPresentationMap3D, 'createPresentationMap2D', map => {
    if (state) map.update?.(state);
    if (paused) map.pause?.(true);
  });
  void surface.start();
  return {
    update(next) { if (!next || typeof next !== 'object') return; state = next; surface.call('update', state); },
    pause(next = true) { paused = Boolean(next); surface.call('pause', paused); },
    resize: () => surface.call('resize'),
    destroy: () => surface.destroy(),
  };
}
