/* Offering v2. One geographic scene, one shared clock, two real map renderers.
 * MapLibre draws buildings in WebGL2; the tested OpenLayers ESM bundle draws
 * the same OpenFreeMap vector data in Canvas when WebGL2 is unavailable.
 * At world scale, Natural Earth's public-domain coastlines form a real globe.
 * No coordinates, contributions, or satellite photographs are invented. */
import { distanceKm, greatCirclePath, timelineElapsedMs, createSelectionMap as createOriginalSelectionMap } from '../map.js';
import { geoOrthographic, geoPath, geoGraticule10 } from './map-geo.js';
import { createAerialTiles } from './map-aerial.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const GL_URL = 'https://unpkg.com/maplibre-gl@6.16.0/dist/maplibre-gl.mjs';
const GL_CSS = 'https://unpkg.com/maplibre-gl@6.16.0/dist/maplibre-gl.css';
const CENTER = { lat: 43.0421035, lng: -76.1339149, label: 'Whitman · Syracuse' };
const RAD = Math.PI / 180, TAU = Math.PI * 2;
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => { const p = clamp(t); return p * p * (3 - 2 * p); };
const wrap = lng => ((lng + 180) % 360 + 360) % 360 - 180;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const settings = raw => ({ center: CENTER, radiusKm: 64.3736, localDurationMs: 50000, hometownDurationMs: 60000, ...raw });
const empty = () => ({ type: 'FeatureCollection', features: [] });
const timeNumber = value => typeof value === 'number' ? value : Date.parse(value);
const reducedMotion = () => typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
let stylePromise, geoPromise;
const cssLoads = new Map();

function loadCSS(href) {
  if (!cssLoads.has(href)) cssLoads.set(href, new Promise((resolve, reject) => {
    const previous = [...document.querySelectorAll('link[rel="stylesheet"]')].find(link => link.getAttribute('href') === href);
    if (previous?.sheet) { resolve(); return; }
    const link = previous || document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
    const timer = setTimeout(() => { cssLoads.delete(href); link.remove(); reject(new Error('map styles took too long to load')); }, 16000);
    link.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    link.addEventListener('error', () => { clearTimeout(timer); cssLoads.delete(href); link.remove(); reject(new Error('map styles could not load')); }, { once: true });
    if (!previous) document.head.append(link);
  }));
  return cssLoads.get(href);
}
function sourceStyle() {
  if (!stylePromise) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 16000);
    stylePromise = fetch(STYLE_URL, { credentials: 'omit', signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error('the geographic map style could not load'); return response.json();
    }).catch(error => { stylePromise = null; throw error; }).finally(() => clearTimeout(timer));
  }
  return stylePromise.then(style => structuredClone(style));
}
function worldLand() {
  if (!geoPromise) geoPromise = fetch('/v2/map-land.json').then(response => {
    if (!response.ok) throw new Error('the world coastlines could not load'); return response.json();
  }).catch(error => { geoPromise = null; throw error; });
  return geoPromise;
}

/** Cumulative motion stays monotone. Its speed gently rises and falls across
 * breaths, without stopping the camera on every exhale. */
function drift(p) {
  const t = clamp(p);
  return clamp(t - .055 * Math.sin(TAU * t) - .006 * Math.sin(TAU * 5 * t));
}
function normalizeEntry(raw, index = 0) {
  const place = raw?.place || raw;
  if (!place || !finite(place.lat) || !finite(place.lng) || Math.abs(place.lat) > 90 || Math.abs(place.lng) > 180) return null;
  return { ...raw, id: String(raw.id ?? index), round: ['hometown', 'home'].includes(raw.round) ? 'hometown' : 'local',
    place: { ...place, label: String(place.label || 'chosen place').slice(0, 160) },
    displayName: raw.anonymous ? '' : String(raw.displayName || raw.who || '').slice(0, 60) };
}
function roundProgress(state, config, now, preview = null) {
  const home = String(state.phase).startsWith('hometown') || state.phase === 'complete';
  const duration = Number(state.clock?.durationMs) || (home ? config.hometownDurationMs : config.localDurationMs);
  const phase = state.phase || 'local_open';
  if (preview !== null) return clamp(preview);
  if (phase.endsWith('_rest') || phase === 'complete') return 1;
  if (!phase.endsWith('_reveal')) return 0;
  return clamp(timelineElapsedMs(state.clock, now) / duration);
}
function reveal(entry, p, config) {
  const distance = distanceKm(config.center, entry.place);
  if (entry.round === 'local') {
    const threshold = clamp(Math.log(Math.max(.12, distance) / .12) / Math.log(Math.max(1, config.radiusKm) / .12));
    return smooth((drift(p) - .04 - threshold * .82) / .13);
  }
  const threshold = clamp(Math.log(Math.max(40, distance) / 40) / Math.log(20020 / 40));
  return smooth((drift(clamp((p - .12) / .88)) - .015 - threshold * .77) / .2);
}

/** The rail can use the exact same deterministic arrival rule as the map.
 * This describes rendered contribution progress, never online presence. */
export function entryRevealProgress(state, rawEntry, rawConfig = {}, now = Date.now()) {
  const config = settings(rawConfig), entry = normalizeEntry(rawEntry);
  if (!entry) return 0;
  const phase = state?.phase || 'local_open';
  const home = phase.startsWith('hometown') || phase === 'complete';
  if (entry.round === 'local') {
    if (home) return finite(state.localProgressAtHandoff) ? reveal(entry, state.localProgressAtHandoff, config) : 1;
    if (phase === 'local_rest') return 1;
    return phase === 'local_reveal' ? reveal(entry, roundProgress(state, config, now), config) : 0;
  }
  if (phase === 'hometown_rest' || phase === 'complete') return 1;
  return phase === 'hometown_reveal' ? reveal(entry, roundProgress(state, config, now), config) : 0;
}

function styleFor(source, detail, canvas) {
  const style = structuredClone(source);
  style.layers = style.layers.filter(layer => layer.id !== 'natural_earth');
  for (const layer of style.layers) {
    const id = layer.id, paint = layer.paint ||= {}, layout = layer.layout ||= {};
    if (layer.type === 'background') paint['background-color'] = '#f3eff7';
    if (layer.type === 'fill') {
      paint['fill-color'] = /water/.test(id) ? '#d7dfeb' : /building/.test(id) ? '#d4c6df' :
        /wood|grass|park|cemetery/.test(id) ? '#e3e7df' : /school|hospital/.test(id) ? '#e9e2f0' : '#ede9f1';
      delete paint['fill-pattern'];
    }
    if (layer.type === 'line') {
      if (/water/.test(id)) paint['line-color'] = '#cbd6e6';
      else if (/boundary/.test(id)) { paint['line-color'] = '#c3b7cf'; paint['line-opacity'] = detail ? .5 : .25; }
      else if (/casing/.test(id)) paint['line-color'] = '#ded6e6';
      else if (/road|bridge|tunnel/.test(id)) paint['line-color'] = /rail/.test(id) ? '#d1c8d9' : '#fffafe';
      else if (/park/.test(id)) paint['line-color'] = '#d5ddd0';
    }
    if (layer.type === 'symbol') {
      if (canvas) layout['text-font'] = ['sans-serif'];
      paint['text-color'] = '#75657f'; paint['text-halo-color'] = '#faf7fc'; paint['text-halo-width'] = 1.4;
      const minor = /poi|shield|airport|one_way/.test(id);
      layout.visibility = minor && !detail ? 'none' : (layer.layout.visibility || 'visible');
      paint['text-opacity'] = detail ? .92 : /highway/.test(id) ? .5 : .74;
      if (!detail) paint['icon-opacity'] = 0;
    }
    if (layer.type === 'fill-extrusion') {
      if (canvas) {
        // Canvas has no extrusion renderer. Retain the actual building
        // footprints at campus zoom instead of silently dropping the data.
        layer.type = 'fill'; layer.paint = { 'fill-color': '#d4c6df', 'fill-opacity': .85, 'fill-outline-color': '#c5b5d3' };
      } else {
        paint['fill-extrusion-color'] = '#cdbbda'; paint['fill-extrusion-opacity'] = .76;
      }
    }
  }
  return style;
}
function canUseGL() {
  try {
    const canvas = document.createElement('canvas'), context = canvas.getContext('webgl2');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext(); return true;
  } catch { return false; }
}

async function createGL(container, source, callbacks) {
  const [library] = await Promise.all([import(GL_URL), loadCSS(GL_CSS)]);
  if (library.supported && !library.supported()) throw new Error('WebGL2 is unavailable');
  let map, closed = false;
  try {
    map = new library.Map({ container, style: styleFor(source, false, false),
      center: [CENTER.lng, CENTER.lat], zoom: 16.5, pitch: 48, bearing: -17,
      interactive: false, attributionControl: false, maxZoom: 20,
      fadeDuration: 220, canvasContextAttributes: { antialias: true } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('3D map took too long to load')), 18000);
      map.once('load', () => { clearTimeout(timer); resolve(); });
      map.getCanvas().addEventListener('webglcontextlost', () => {
        if (closed) return; clearTimeout(timer); callbacks.onLost?.(); reject(new Error('map graphics became unavailable'));
      }, { once: true });
    });
    return {
      type: 'webgl',
      pose(pose) { map.jumpTo({ center: [pose.lng, pose.lat], zoom: pose.zoom - 1, pitch: pose.pitch || 0, bearing: pose.bearing || 0 }); },
      project(place) { const p = map.project([place.lng, place.lat]); return [p.x, p.y]; },
      setMode(mode) {
        const styled = styleFor(source, mode === 'detail', false);
        for (const layer of styled.layers) {
          if (!map.getLayer(layer.id)) continue;
          for (const [name, value] of Object.entries(layer.paint || {})) { try { map.setPaintProperty(layer.id, name, value); } catch {} }
          if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', layer.layout?.visibility || 'visible');
        }
      },
      resize() { map.resize(); },
      destroy() { closed = true; map.remove(); },
    };
  } catch (error) { closed = true; map?.remove(); throw error; }
}

async function createCanvasMap(container, source, callbacks) {
  const [library] = await Promise.all([import('/vendor/vector-map.js'), loadCSS('/vendor/ol.css')]);
  const { Map: CanvasMap, View, LayerGroup, VectorTileSource, TileState, fromLonLat, apply } = library;
  const view = new View({ center: fromLonLat([CENTER.lng, CENTER.lat]), zoom: 17.5,
    minZoom: 0, maxZoom: 21, enableRotation: false, constrainResolution: false, constrainOnlyCenter: true, multiWorld: true });
  const map = new CanvasMap({ target: container, view, layers: [], controls: [], interactions: [], pixelRatio: Math.min(devicePixelRatio || 1, 2) });
  let group = new LayerGroup(), destroyed = false, styleGeneration = 0, hasData = false, failures = 0, lastNotice = 0;
  const sources = new Set(), removers = [];
  function watch(layer) {
    if (layer.getLayers) { layer.getLayers().forEach(watch); return; }
    const source = layer.getSource?.(); if (!source || sources.has(source)) return;
    sources.add(source);
    const loaded = event => {
      if (destroyed || !(source instanceof VectorTileSource) || event.tile?.getState?.() !== TileState.LOADED) return;
      hasData = true; failures = 0; callbacks.onData?.();
    };
    const failed = () => {
      if (destroyed) return;
      if (++failures >= 4 && Date.now() - lastNotice > 6000) {
        lastNotice = Date.now(); callbacks.onNotice?.('some geography could not load. your places are still held; you can retry.');
      }
    };
    source.on('tileloadend', loaded); source.on('tileloaderror', failed);
    removers.push(() => { source.un('tileloadend', loaded); source.un('tileloaderror', failed); });
  }
  try {
    await apply(group, styleFor(source, false, true), { styleUrl: STYLE_URL });
    watch(group); map.addLayer(group); map.updateSize(); map.renderSync();
    return {
      type: 'canvas',
      get hasData() { return hasData; },
      pose(pose) {
        const next = fromLonLat([pose.lng, clamp(pose.lat, -85, 85)]), before = view.getCenter();
        if (Math.abs((before?.[0] || 0) - next[0]) > .001 || Math.abs((before?.[1] || 0) - next[1]) > .001) view.setCenter(next);
        if (Math.abs(view.getZoom() - pose.zoom) > .00005) view.setZoom(pose.zoom);
      },
      project(place) { return map.getPixelFromCoordinate(fromLonLat([place.lng, clamp(place.lat, -85, 85)])); },
      async setMode(mode) {
        const generation = ++styleGeneration, next = new LayerGroup();
        try {
          await apply(next, styleFor(source, mode === 'detail', true), { styleUrl: STYLE_URL });
          if (destroyed || generation !== styleGeneration) { next.getLayers().clear(); return; }
          watch(next); map.addLayer(next); map.removeLayer(group); group.getLayers().clear(); group = next; map.render();
        } catch { callbacks.onNotice?.('some map details could not load. the existing map remains.'); }
      },
      resize() { map.updateSize(); },
      destroy() {
        destroyed = true; styleGeneration++; for (const remove of removers) remove();
        map.setTarget(undefined); map.dispose(); group.getLayers().clear(); for (const source of sources) source.dispose?.();
      },
    };
  } catch (error) { map.setTarget(undefined); map.dispose(); throw error; }
}

function mercator(place, zoom) {
  const world = 256 * 2 ** zoom, lat = clamp(place.lat, -85.05112878, 85.05112878) * RAD;
  return [(place.lng + 180) / 360 * world, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * world];
}
function inverseMercator(point, zoom) {
  const world = 256 * 2 ** zoom;
  return { lng: wrap(point[0] / world * 360 - 180), lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * point[1] / world))) / RAD };
}
function poseForRadius(config, size, radius) {
  const usable = Math.max(140, Math.min(size.width, size.height) - 180);
  const metersPerPixel = radius * 2000 / usable;
  return { ...config.center, zoom: clamp(Math.log2(156543.03392 * Math.cos(config.center.lat * RAD) / metersPerPixel), 2, 17.5), pitch: 0, bearing: 0, globe: 0 };
}
function focusPose(entry, config, size) {
  if (entry.round === 'hometown' && distanceKm(config.center, entry.place) > 900) {
    const middle = greatCirclePath(config.center, entry.place, 2)[1];
    return { lng: middle[0], lat: clamp(middle[1], -65, 65), zoom: 3, pitch: 0, bearing: 0, globe: 1, globeScale: 1 };
  }
  const first = mercator(config.center, 0), last = mercator(entry.place, 0);
  last[0] = first[0] + wrap(entry.place.lng - config.center.lng) / 360 * 256;
  const width = Math.max(.0008, Math.abs(last[0] - first[0])), height = Math.max(.0008, Math.abs(last[1] - first[1]));
  const zoom = clamp(Math.log2(Math.min(Math.max(160, size.width - 260) / width, Math.max(160, size.height - 240) / height)), 2, 17.5);
  return { ...inverseMercator([(first[0] + last[0]) / 2, (first[1] + last[1]) / 2], 0), zoom, pitch: 0, bearing: 0, globe: 0 };
}
function slicePath(path, progress) {
  if (progress >= 1) return path;
  const last = clamp(progress) * (path.length - 1), index = Math.floor(last), fraction = last - index;
  const points = path.slice(0, index + 1);
  if (fraction > 0 && path[index + 1]) points.push([wrap(path[index][0] + wrap(path[index + 1][0] - path[index][0]) * fraction), mix(path[index][1], path[index + 1][1], fraction)]);
  return points;
}
function blendPose(a, b, t) {
  return { lng: wrap(a.lng + wrap(b.lng - a.lng) * t), lat: mix(a.lat, b.lat, t), zoom: mix(a.zoom, b.zoom, t),
    pitch: mix(a.pitch || 0, b.pitch || 0, t), bearing: mix(a.bearing || 0, b.bearing || 0, t), globe: mix(a.globe || 0, b.globe || 0, t),
    globeScale: mix(a.globeScale || 1, b.globeScale || 1, t) };
}
function interpolatePoint(a, b, progress) {
  const vector = point => [Math.cos(point.lat * RAD) * Math.cos(point.lng * RAD), Math.cos(point.lat * RAD) * Math.sin(point.lng * RAD), Math.sin(point.lat * RAD)];
  const first = vector(a), last = vector(b), dot = clamp(first.reduce((sum, n, i) => sum + n * last[i], 0), -1, 1);
  const angle = Math.acos(dot), sine = Math.sin(angle), t = clamp(progress);
  if (angle < 1e-8) return { lng: a.lng, lat: a.lat };
  if (Math.abs(sine) < 1e-6) { const p = greatCirclePath(a, b, 100)[Math.round(t * 100)]; return { lng: p[0], lat: p[1] }; }
  const v = first.map((n, i) => n * Math.sin((1 - t) * angle) / sine + last[i] * Math.sin(t * angle) / sine);
  return { lng: Math.atan2(v[1], v[0]) / RAD, lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD };
}

export async function createPresentationMap(container, { config: rawConfig = {}, onStatus } = {}) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) throw new Error('a map container is required');
  const config = settings(rawConfig), preference = reducedMotion();
  root.classList.add('v2-map-root');
  const base = document.createElement('div'); base.className = 'v2-map-base'; base.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas'); canvas.className = 'v2-map-ink'; canvas.setAttribute('aria-hidden', 'true');
  const vignette = document.createElement('div'); vignette.className = 'v2-map-vignette';
  const status = document.createElement('div'); status.className = 'v2-map-message'; status.setAttribute('role', 'status');
  const statusText = document.createElement('p'), retry = document.createElement('button');
  retry.type = 'button'; retry.textContent = 'try the map again'; retry.hidden = true; status.append(statusText, retry);
  const attribution = document.createElement('div'); attribution.className = 'v2-map-attribution';
  root.append(base, canvas, vignette, status);
  // The map is an isolated z=0 layer. Credits belong beside that layer, above
  // the presenter's bottom gradient, so required attribution stays readable.
  const attributionHost = root.closest('.wall-stage') || root;
  const externalAttribution = attributionHost !== root;
  const previousCreditHeight = attributionHost.style.getPropertyValue('--v2-map-credit-height');
  const alreadyCreditHost = attributionHost.classList.contains('v2-map-credits-host');
  if (externalAttribution) {
    attribution.classList.add('v2-map-attribution--stage'); attributionHost.classList.add('v2-map-credits-host');
  }
  attributionHost.append(attribution);
  const positionCredits = () => {
    if (externalAttribution) attributionHost.style.setProperty('--v2-map-credit-height', `${Math.ceil(attribution.getBoundingClientRect().height)}px`);
  };
  const creditObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(positionCredits) : null;
  creditObserver?.observe(attribution);
  const ctx = canvas.getContext('2d');
  let state = { phase: 'local_open', entries: [], clock: {} }, entries = [], paths = new Map(), entrySignature = '', distantEntries = [];
  let engine = null, land = null, mode = 'quiet', focusId = null, focusSignature = '', preview = null, destroyed = false, ready = false, generation = 0;
  let raf = 0, previousFrame = 0, scenePose = null, size = { width: 1, height: 1, dpr: 1 }, phaseChangedAt = performance.now();
  let serverOffset = null, noticeTimer, loadTimer, focusTransition = null, arrivedAt = new Map(), initializedEntries = false;
  let oldSession = null, canvasDataLoaded = false, attributionKey = '', lastCapabilities = '', aerial = null, lastGlobeTurn = 0;
  let motionPaused = false, orbitElapsed = 0, localDepartureProgress = 1;
  const graticule = geoGraticule10();
  const imagery = config.imagery?.enabled && /^https:\/\/orthos\.its\.ny\.gov\//.test(config.imagery.tileUrl || '') ? config.imagery : null;

  function currentNow() { return Date.now() + (serverOffset || 0); }
  function isHome() { return String(state.phase).startsWith('hometown') || state.phase === 'complete'; }
  function canAerial() {
    const entry = entries.find(entry => entry.id === focusId);
    const bounds = imagery?.bounds || [-76.93, 42.46, -75.34, 43.63];
    const place = entry?.place || config.center;
    return Boolean(imagery && !isHome() && place.lng >= bounds[0] && place.lng <= bounds[2] && place.lat >= bounds[1] && place.lat <= bounds[3]);
  }
  function capabilities() { return { quiet: true, detail: true, aerial: canAerial() }; }
  function notify(message = '', stateName = 'ready') {
    if (destroyed) return;
    try { onStatus?.({ message, state: stateName, available: ready, ready, renderer: engine?.type || 'pending', modes: capabilities(), mode,
      threeDimensional: engine?.type === 'webgl', motionPaused, imagery: imagery ? { name: imagery.name, yearLabel: imagery.yearLabel } : null }); } catch {}
  }
  function message(text, stateName = 'loading', retryable = false) {
    clearTimeout(noticeTimer); statusText.textContent = text; status.dataset.state = stateName; status.hidden = !text; retry.hidden = !retryable;
    notify(text, stateName);
    if (stateName === 'notice') noticeTimer = setTimeout(() => { if (!destroyed && ready) status.hidden = true; }, 6000);
  }
  function markReady() {
    if (destroyed || ready) return;
    ready = true; clearTimeout(loadTimer); status.hidden = true; retry.hidden = true; notify(); redraw();
  }
  function updateAttribution(globe) {
    const key = globe > .999 ? 'globe' : globe > .001 ? `transition-${mode}` : mode;
    if (attributionKey === key) return; attributionKey = key; attribution.replaceChildren();
    const add = (label, url) => {
      if (attribution.childNodes.length) attribution.append(document.createTextNode(' · '));
      const link = document.createElement('a'); link.textContent = label; link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; attribution.append(link);
    };
    if (globe > .001) add('Natural Earth', 'https://www.naturalearthdata.com/');
    if (mode === 'aerial' && globe < .01) {
      add(imagery?.attribution || 'NYS ITS Geospatial Services', 'https://gis.ny.gov/orthoimagery');
      if (imagery?.yearLabel) attribution.append(document.createTextNode(` · ${imagery.yearLabel}`));
    }
    if (globe < .999) {
      add('OpenFreeMap', 'https://openfreemap.org/'); add('OpenMapTiles', 'https://openmaptiles.org/'); add('© OpenStreetMap', 'https://www.openstreetmap.org/copyright');
    }
    positionCredits();
  }
  async function start(forceCanvas = false) {
    const version = ++generation; ready = false; canvasDataLoaded = false; clearTimeout(loadTimer);
    engine?.destroy(); engine = null; base.replaceChildren(); message('opening the geography…');
    try {
      await loadCSS('/v2/map.css');
      const source = await sourceStyle();
      if (destroyed || version !== generation) return;
      let next;
      if (!forceCanvas && canUseGL()) {
        try { next = await createGL(base, source, { onLost() { if (!destroyed && version === generation) void start(true); } }); }
        catch { if (destroyed || version !== generation) return; base.replaceChildren(); }
      }
      if (!next) next = await createCanvasMap(base, source, {
        onData() { if (destroyed || version !== generation) return; canvasDataLoaded = true; if (engine) markReady(); },
        onNotice(text) { if (!destroyed && version === generation) message(text, 'notice', true); },
      });
      if (destroyed || version !== generation) { next.destroy(); return; }
      engine = next; engine.setMode(mode); engine.resize();
      if (engine.type === 'webgl' || canvasDataLoaded) markReady();
      else loadTimer = setTimeout(() => { if (!ready) message('the map data could not arrive. your places are still held.', 'error', true); }, 20000);
      resize(); redraw();
    } catch { if (!destroyed && version === generation) message('the map could not open. check the connection and try again.', 'error', true); }
  }
  function resize() {
    if (destroyed) return;
    const rect = root.getBoundingClientRect(); size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: Math.min(devicePixelRatio || 1, 2) };
    canvas.width = Math.ceil(size.width * size.dpr); canvas.height = Math.ceil(size.height * size.dpr);
    engine?.resize(); redraw();
  }
  function localPose(p) {
    const start = { ...config.center, zoom: 17.5, pitch: engine?.type === 'webgl' && mode !== 'aerial' ? 48 : 0, bearing: engine?.type === 'webgl' && mode !== 'aerial' ? -17 : 0, globe: 0 };
    const last = poseForRadius(config, size, Math.max(2, config.radiusKm) * 1.05);
    const amount = drift(p);
    return { ...config.center, zoom: mix(start.zoom, last.zoom, amount), pitch: start.pitch * (1 - smooth(amount / .5)), bearing: start.bearing * (1 - smooth(amount / .58)), globe: 0 };
  }
  function sharedScene(now) {
    const phase = preview === null ? state.phase || 'local_open' : isHome() ? 'hometown_reveal' : 'local_reveal';
    const p = roundProgress(state, config, now, preview);
    let pose = localPose(0), collapse = 1, round = 'local';
    if (phase === 'local_reveal') pose = localPose(p);
    else if (phase === 'local_rest' || phase === 'hometown_open') pose = localPose(phase === 'hometown_open' ? localDepartureProgress : 1);
    else if (isHome()) {
      round = 'hometown';
      const t = phase === 'hometown_reveal' ? p : 1;
      collapse = 1 - smooth(t / .14);
      const start = localPose(localDepartureProgress), targetRadius = Math.max(110, Math.min(size.width, size.height) * .405);
      const outward = drift(clamp((t - .06) / .94));
      // Turn toward distant arrivals while they emerge. A destination on the
      // other side of Earth must get a view of its own, not disappear behind
      // a globe that always faces Syracuse. Both endpoints usually fit in a
      // hemisphere; near-antipodes gently favor the arriving destination.
      let orientation = { ...config.center };
      for (const entry of distantEntries) {
        const arrival = reveal(entry, t, config); if (arrival <= 0) continue;
        orientation = arrival >= 1 ? { ...entry.midpoint } : interpolatePoint(orientation, entry.midpoint, smooth(arrival));
        orientation.lat = clamp(orientation.lat, -72, 72);
      }
      const endZoom = Math.log2(targetRadius * TAU * Math.max(.25, Math.cos(orientation.lat * RAD)) / 256);
      const zoom = mix(start.zoom, endZoom, outward);
      const globe = land ? smooth((outward - .32) / .25) : 0;
      let lng = orientation.lng;
      if ((phase === 'hometown_rest' || phase === 'complete') && !preference.matches) {
        lastGlobeTurn = orbitElapsed / 1000 * .7; lng = wrap(lng + lastGlobeTurn);
      }
      pose = { ...orientation, lng, zoom, pitch: 0, bearing: 0, globe, globeScale: 1 };
    }
    return { pose, p, collapse, round };
  }
  function desiredPose(scene) {
    const focus = entries.find(entry => entry.id === focusId);
    let pose = focus ? focusPose(focus, config, size) : scene.pose;
    if (focus && pose.globe) {
      const radius = Math.max(110, Math.min(size.width, size.height) * .405);
      pose.zoom = Math.log2(radius * TAU * Math.cos(pose.lat * RAD) / 256);
      if (!land) pose.globe = 0;
    }
    if (mode === 'aerial') pose = { ...pose, pitch: 0, bearing: 0 };
    if (preference.matches) {
      if (!focus && state.phase?.endsWith('_reveal') && preview === null) {
        const duration = Number(state.clock?.durationMs) || 50000;
        const step = Math.floor(scene.p * duration / 10000) * 10000 / duration;
        const previous = preview; preview = step; pose = sharedScene(currentNow()).pose; preview = previous;
      }
      return pose;
    }
    if (focusTransition) {
      const amount = smooth((performance.now() - focusTransition.started) / 1800);
      if (amount >= 1) focusTransition = null;
      else pose = blendPose(focusTransition.from, pose, amount);
    }
    return pose;
  }
  function flatProject(place, pose) {
    if (engine?.type === 'webgl' && pose.globe < .01) {
      try { return engine.project(place); } catch {}
    }
    const p = mercator(place, pose.zoom), center = mercator(pose, pose.zoom), world = 256 * 2 ** pose.zoom;
    let x = p[0] - center[0]; if (x > world / 2) x -= world; if (x < -world / 2) x += world;
    return [size.width / 2 + x, size.height / 2 + p[1] - center[1]];
  }
  function globeProjection(pose) {
    const radius = 256 * 2 ** pose.zoom / (TAU * Math.max(.25, Math.cos(pose.lat * RAD)));
    return geoOrthographic().translate([size.width / 2, size.height / 2]).scale(radius).rotate([-pose.lng, -pose.lat]).clipAngle(90).precision(.35);
  }
  function front(place, pose) {
    return Math.sin(place.lat * RAD) * Math.sin(pose.lat * RAD) + Math.cos(place.lat * RAD) * Math.cos(pose.lat * RAD) * Math.cos((place.lng - pose.lng) * RAD) > .012;
  }
  function drawGlobe(projection, opacity, pose) {
    if (!land || opacity <= 0) return;
    const radius = projection.scale(), x = size.width / 2, y = size.height / 2;
    ctx.save(); ctx.globalAlpha = opacity;
    ctx.fillStyle = '#f3eff7'; ctx.fillRect(0, 0, size.width, size.height);
    const halo = ctx.createRadialGradient(x, y, radius * .93, x, y, radius * 1.12);
    halo.addColorStop(0, '#d3c3e100'); halo.addColorStop(.5, '#d3c3e134'); halo.addColorStop(1, '#d3c3e100');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, radius * 1.12, 0, TAU); ctx.fill();
    const path = geoPath(projection, ctx);
    const ocean = ctx.createRadialGradient(x - radius * .28, y - radius * .3, radius * .12, x, y, radius);
    ocean.addColorStop(0, '#e5e8f2'); ocean.addColorStop(.7, '#dbe1ed'); ocean.addColorStop(1, '#c6ccdd');
    ctx.fillStyle = ocean; ctx.beginPath(); path({ type: 'Sphere' }); ctx.fill();
    ctx.save(); ctx.beginPath(); path({ type: 'Sphere' }); ctx.clip();
    ctx.fillStyle = '#eee8f3'; ctx.strokeStyle = '#bfaeca'; ctx.lineWidth = .8;
    ctx.beginPath(); path(land); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#aea2bd24'; ctx.lineWidth = .65; ctx.beginPath(); path(graticule); ctx.stroke();
    const shade = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    shade.addColorStop(0, '#fffaff29'); shade.addColorStop(.6, '#76618800'); shade.addColorStop(1, '#48325220');
    ctx.fillStyle = shade; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2); ctx.restore(); ctx.restore();
  }
  function drawThread(path, amount, opacity, selected, pose, projection) {
    if (amount <= .001 || opacity <= 0) return;
    const partial = slicePath(path, amount); if (partial.length < 2) return;
    ctx.save(); ctx.globalAlpha = opacity;
    const trace = () => {
      ctx.beginPath();
      if (pose.globe > .6 && projection) geoPath(projection, ctx)({ type: 'LineString', coordinates: partial });
      else {
        let previous = null;
        for (const [lng, lat] of partial) {
          const p = flatProject({ lng, lat }, pose);
          if (!previous || Math.abs(p[0] - previous[0]) > size.width * .8) ctx.moveTo(...p); else ctx.lineTo(...p);
          previous = p;
        }
      }
    };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    trace(); ctx.strokeStyle = mode === 'aerial' ? '#f5eaff50' : '#a887ba24'; ctx.lineWidth = selected ? 9 : 6; ctx.stroke();
    trace(); ctx.strokeStyle = mode === 'aerial' ? '#f6edff' : selected ? '#705084' : '#91729f'; ctx.lineWidth = selected ? 2.5 : 1.45; ctx.stroke();
    ctx.restore();
  }
  function drawPoint(point, opacity, origin = false, selected = false) {
    if (!point || point.some(n => !Number.isFinite(n)) || opacity <= 0) return;
    const [x, y] = point, radius = origin ? 28 : selected ? 24 : 15;
    if (x < -radius || x > size.width + radius || y < -radius || y > size.height + radius) return;
    ctx.save(); ctx.globalAlpha = opacity;
    const gradient = ctx.createRadialGradient(x, y, 1, x, y, radius);
    gradient.addColorStop(0, '#b99ace70'); gradient.addColorStop(.4, '#b99ace24'); gradient.addColorStop(1, '#b99ace00');
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
    ctx.fillStyle = mode === 'aerial' ? '#faf0ff' : origin ? '#735185' : '#89629a';
    ctx.strokeStyle = mode === 'aerial' ? '#5e4173' : '#fcf8ff'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(x, y, origin ? 5.1 : selected ? 4.8 : 3.3, 0, TAU); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  function drawLabels(labels) {
    const occupied = [], margin = 20;
    for (const item of labels.sort((a, b) => Number(Boolean(b.origin)) - Number(Boolean(a.origin)) || Number(Boolean(b.selected)) - Number(Boolean(a.selected)))) {
      const [x, y] = item.point;
      if (!finite(x) || !finite(y)) continue;
      let label = item.label;
      ctx.font = `${item.selected || item.origin ? '600' : '500'} ${item.selected ? 13 : 11}px Nunito,system-ui,sans-serif`;
      while (ctx.measureText(label).width > 178 && label.length > 10) label = label.slice(0, -2);
      if (label !== item.label) label += '…';
      const width = Math.max(ctx.measureText(label).width, item.who ? ctx.measureText(item.who).width : 0) + 16;
      const height = item.who ? 42 : 26;
      const rect = { x: x - width / 2, y: item.origin ? y - height - 12 : y + 12, width, height };
      if (rect.x < margin || rect.x + width > size.width - margin || rect.y < margin || rect.y + height > size.height - 35) continue;
      if (!item.selected && occupied.some(other => rect.x < other.x + other.width + 8 && rect.x + width + 8 > other.x && rect.y < other.y + other.height + 4 && rect.y + height + 4 > other.y)) continue;
      occupied.push(rect);
      ctx.save(); ctx.globalAlpha = item.opacity; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = mode === 'aerial' ? '#f8f0ffed' : '#faf7fbd9';
      ctx.beginPath(); ctx.roundRect(rect.x, rect.y - 3, width, height, 7); ctx.fill();
      ctx.fillStyle = '#5d456f'; ctx.fillText(label, x, rect.y + 2);
      if (item.who) { ctx.font = '400 10px Nunito,system-ui,sans-serif'; ctx.fillStyle = '#786487'; ctx.fillText(item.who, x, rect.y + 19); }
      ctx.restore();
    }
  }
  function render(frameTime) {
    if (destroyed || !ctx) return;
    const delta = previousFrame ? clamp(frameTime - previousFrame, 0, 80) : 16; previousFrame = frameTime;
    if (!motionPaused && !focusId && !preference.matches && preview === null && ['hometown_rest', 'complete'].includes(state.phase)) orbitElapsed += delta;
    const now = currentNow(), scene = sharedScene(now), target = desiredPose(scene);
    // Small timing corrections and newly received contributions never jerk the
    // camera. Explicit seek/focus uses its own longer, reversible transition.
    scenePose = !scenePose || preference.matches ? target : blendPose(scenePose, target, 1 - Math.exp(-delta / 95));
    const pose = scenePose;
    engine?.pose(pose);
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0); ctx.clearRect(0, 0, size.width, size.height);
    const projection = land && pose.globe > .001 ? globeProjection(pose) : null;
    if (mode === 'aerial' && aerial && pose.globe < .01 && Math.abs(pose.pitch) < .1 && Math.abs(pose.bearing) < .1) aerial.draw(ctx, pose, size);
    drawGlobe(projection, pose.globe || 0, pose);
    base.style.opacity = String(1 - (pose.globe || 0));
    updateAttribution(pose.globe || 0);
    if (!ready && !(land && pose.globe > .8)) return;
    const labels = [], focus = entries.find(entry => entry.id === focusId);
    const project = place => pose.globe > .6 && projection ? (front(place, pose) ? projection([place.lng, place.lat]) : null) : flatProject(place, pose);
    for (const entry of entries) {
      const selected = entry.id === focusId;
      let amount = selected ? 1 : entryRevealProgress(state, entry, config, now);
      if (preview !== null && entry.round === scene.round) amount = selected ? 1 : reveal(entry, preview, config);
      if (entry.round === 'local' && (scene.round === 'hometown' || state.phase === 'hometown_open')) {
        amount = reveal(entry, localDepartureProgress, config);
        if (scene.round === 'hometown') amount *= scene.collapse;
        if (selected) amount = 1;
      }
      if (entry.round === 'hometown' && scene.round !== 'hometown' && !selected) amount = 0;
      const firstSeen = arrivedAt.get(entry.id);
      if (!selected && preview === null && firstSeen && !preference.matches) amount = Math.min(amount, smooth((performance.now() - firstSeen) / 1800));
      if (preference.matches) amount = amount > .999 ? 1 : 0;
      if (amount <= .001) continue;
      const opacity = focus ? (selected ? 1 : .18) : 1;
      drawThread(paths.get(entry.id), amount, opacity * .8, selected, pose, projection);
      const pinAlpha = smooth((amount - .82) / .18) * opacity, point = project(entry.place);
      drawPoint(point, pinAlpha, false, selected);
      if (point && pinAlpha > .1 && (!focus || selected || mode === 'detail')) labels.push({ point, label: entry.place.label,
        who: entry.displayName, opacity: pinAlpha, selected });
    }
    const origin = project(config.center);
    drawPoint(origin, 1, true, false);
    if (origin) labels.push({ point: origin, label: isHome() && state.phase !== 'hometown_open' ? 'Syracuse' : config.center.label,
      who: '', opacity: 1, origin: true });
    drawLabels(labels);
  }
  function animating() {
    if (destroyed || document.hidden || preference.matches) return false;
    if (focusTransition) return true;
    if ([...arrivedAt.values()].some(at => performance.now() - at < 2100)) return true;
    if (state.phase?.endsWith('_reveal') && !state.clock?.paused && preview === null) return true;
    return !focusId && !motionPaused && preview === null && ['hometown_rest', 'complete'].includes(state.phase);
  }
  function frame(time) {
    raf = 0; render(time);
    if (animating()) raf = requestAnimationFrame(frame);
  }
  function redraw() { if (!raf && !destroyed && !document.hidden) raf = requestAnimationFrame(frame); }
  function changeFocus(id) {
    if (id === focusId) return;
    if (scenePose) focusTransition = { from: { ...scenePose }, started: performance.now() };
    focusId = id; redraw();
  }
  function onVisibility() { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else { previousFrame = 0; redraw(); } }
  function onMotion() { focusTransition = null; scenePose = null; redraw(); }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; observer?.observe(root);
  preference.addEventListener?.('change', onMotion); document.addEventListener('visibilitychange', onVisibility);
  retry.addEventListener('click', () => { aerial?.retry(); void start(); });
  if (imagery) aerial = createAerialTiles(imagery, redraw, () => {
    if (mode !== 'aerial') return;
    mode = 'quiet'; aerial?.setActive(false); engine?.setMode('quiet');
    message('aerial imagery could not arrive. showing the geographic map; you can choose aerial to try again.', 'notice'); redraw();
  });
  void worldLand().then(value => { if (!destroyed) { land = value; redraw(); } }).catch(() => { /* Flat geographic map remains usable. */ });
  resize(); void start();
  return {
    update(next) {
      if (!next || typeof next !== 'object' || destroyed) return;
      const serverNow = timeNumber(next.serverTime || next.serverNow);
      if (Number.isFinite(serverNow)) {
        const measured = serverNow - Date.now();
        if (serverOffset === null || Math.abs(measured - serverOffset) > 2500) serverOffset = measured;
        else serverOffset += (measured - serverOffset) * .08;
      }
      if (next.sessionId !== oldSession) {
        oldSession = next.sessionId; initializedEntries = false; arrivedAt.clear(); focusId = null; scenePose = null; preview = null; orbitElapsed = 0; localDepartureProgress = 1;
      }
      if (next.phase !== state.phase) {
        if (next.phase === 'hometown_open' && state.phase?.startsWith('local')) {
          localDepartureProgress = state.phase === 'local_rest' ? 1 : roundProgress(state, config, currentNow(), preview);
        }
        phaseChangedAt = performance.now(); lastGlobeTurn = 0;
        if (!['hometown_rest', 'complete'].includes(state.phase)) orbitElapsed = 0;
        if (scenePose) focusTransition = { from: { ...scenePose }, started: performance.now() };
      }
      if (finite(next.localProgressAtHandoff)) localDepartureProgress = clamp(next.localProgressAtHandoff);
      state = next;
      const normalized = (Array.isArray(next.entries) ? next.entries : []).map(normalizeEntry).filter(Boolean);
      const signature = JSON.stringify(normalized.map(entry => [entry.id, entry.round, entry.displayName, entry.place]));
      if (signature !== entrySignature) {
        const previousIds = new Set(entries.map(entry => entry.id));
        entries = normalized; entrySignature = signature; paths = new Map(); distantEntries = [];
        for (const entry of entries) {
          paths.set(entry.id, greatCirclePath(config.center, entry.place, entry.round === 'local' ? 48 : 144));
          const distance = distanceKm(config.center, entry.place);
          if (entry.round === 'hometown' && distance > 6000) {
            const route = paths.get(entry.id), midway = route[Math.round((route.length - 1) * .54)];
            distantEntries.push({ ...entry, distance, midpoint: { lng: midway[0], lat: midway[1] } });
          }
          if (initializedEntries && !previousIds.has(entry.id)) arrivedAt.set(entry.id, performance.now());
        }
        distantEntries.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
        initializedEntries = true;
        if (focusId && !entries.some(entry => entry.id === focusId)) changeFocus(null);
      }
      if (mode === 'aerial' && !canAerial()) { mode = 'quiet'; aerial?.setActive(false); engine?.setMode('quiet'); }
      const capabilityKey = JSON.stringify(capabilities());
      if (capabilityKey !== lastCapabilities) { lastCapabilities = capabilityKey; notify(); }
      redraw();
    },
    focusEntry(rawEntry) {
      const nextId = rawEntry ? String(rawEntry.id) : null;
      const signature = rawEntry ? JSON.stringify([nextId, rawEntry.place, rawEntry.displayName]) : '';
      if (nextId === focusId && signature !== focusSignature && scenePose) focusTransition = { from: { ...scenePose }, started: performance.now() };
      focusSignature = signature; changeFocus(nextId); redraw();
    },
    setMotionPaused(paused) {
      const next = Boolean(paused); if (next === motionPaused) return;
      motionPaused = next; notify(); redraw();
    },
    setMode(nextMode) {
      if (!['quiet', 'detail', 'aerial'].includes(nextMode) || destroyed) return false;
      if (nextMode === 'aerial' && !canAerial()) { message('aerial imagery is available for the local Syracuse round.', 'notice'); return false; }
      if (mode !== nextMode) {
        if (scenePose) focusTransition = { from: { ...scenePose }, started: performance.now() };
        mode = nextMode; engine?.setMode(mode); aerial?.setActive(mode === 'aerial'); if (mode === 'aerial') aerial?.retry(); notify(); redraw();
      }
      return true;
    },
    setProgressPreview(fractionOrNull) {
      preview = fractionOrNull === null ? null : clamp(Number(fractionOrNull) || 0);
      // Scrubbing is direct manipulation; its position is the displayed
      // position. Never queue a long camera tween behind the pointer.
      focusTransition = null; scenePose = null;
      redraw();
    },
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true; generation++; cancelAnimationFrame(raf); clearTimeout(loadTimer); clearTimeout(noticeTimer);
      observer?.disconnect(); creditObserver?.disconnect(); preference.removeEventListener?.('change', onMotion); document.removeEventListener('visibilitychange', onVisibility);
      aerial?.destroy(); engine?.destroy(); base.remove(); canvas.remove(); status.remove(); vignette.remove(); attribution.remove(); root.classList.remove('v2-map-root');
      if (externalAttribution) {
        if (!alreadyCreditHost) attributionHost.classList.remove('v2-map-credits-host');
        if (previousCreditHeight) attributionHost.style.setProperty('--v2-map-credit-height', previousCreditHeight);
        else attributionHost.style.removeProperty('--v2-map-credit-height');
      }
    },
  };
}

/** The participant selector retains the already verified map fallback and
 * coordinate/radius rules. All selected points still go through server checks. */
export async function createSelectionMap(container, options = {}) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  root?.classList.add('v2-selection-map');
  void loadCSS('/v2/map.css');
  const map = await createOriginalSelectionMap(container, { ...options,
    onStatus(message, detail) { options.onStatus?.({ ...detail, message, modes: { quiet: true, detail: true, aerial: false } }); } });
  return { ...map, select: place => map.setSelection?.(place), destroy() { map.destroy(); root?.classList.remove('v2-selection-map'); } };
}
