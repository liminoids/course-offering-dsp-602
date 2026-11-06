/* Canvas basemap for the compatible map. Leaflet owns input and the offering's
 * overlays; OpenLayers draws the same OpenFreeMap geography without WebGL.
 * https://openfreemap.org/quick_start/#using-openlayers
 */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const LOAD_TIMEOUT = 20000;
const loads = new Map();
let libraryPromise;

function loadStyle(url) {
  if (!loads.has(url)) {
    const pending = new Promise((resolve, reject) => {
      const node = document.createElement('link'); node.rel = 'stylesheet'; node.href = url;
      let finished = false;
      const finish = error => {
        if (finished) return; finished = true; clearTimeout(timer);
        node.onload = null; node.onerror = null;
        if (error) { node.remove(); reject(error); } else resolve();
      };
      node.onload = () => finish();
      node.onerror = () => finish(new Error('A map resource could not load.'));
      const timer = setTimeout(() => finish(new Error('A map resource took too long to load.')), LOAD_TIMEOUT);
      document.head.append(node);
    }).catch(error => { loads.delete(url); throw error; });
    loads.set(url, pending);
  }
  return loads.get(url);
}

async function libraries() {
  // The ESM bundle includes the exact OpenLayers modules required by OLMS.
  // Its UMD build assumes globals (such as ImageState) absent from ol.js.
  if (!libraryPromise) libraryPromise = import('/vendor/vector-map.js').catch(error => { libraryPromise = null; throw error; });
  const resources = Promise.all([libraryPromise, loadStyle('/vendor/ol.css')]);
  const [library] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The map library took too long to load.')), LOAD_TIMEOUT);
    resources.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  return library;
}

/**
 * container is an absolute, untransformed sibling below Leaflet's own container.
 * onReady requires an actually loaded vector tile followed by a rendered frame.
 * The returned handle is available while the style and map data are still loading.
 */
export async function createVectorBasemap({ map, container, onReady, onError, onNotice }) {
  if (!map || !container) throw new Error('A map and basemap container are required.');
  const { Map: CanvasMap, View, LayerGroup, VectorTileSource, fromLonLat, apply, TileState } = await libraries();
  const center = map.getCenter();
  const view = new View({
    center: fromLonLat([center.lng, center.lat]), zoom: map.getZoom(),
    minZoom: 0, maxZoom: 22, enableRotation: false,
    constrainResolution: false, constrainOnlyCenter: true, multiWorld: true,
  });
  const group = new LayerGroup();
  // olms creates Canvas Tile/VectorTile layers. No WebGL renderer is used here.
  const canvasMap = new CanvasMap({ target: container, view, layers: [], controls: [], interactions: [] });
  container.setAttribute('aria-hidden', 'true');
  container.style.pointerEvents = 'none';
  let destroyed = false, frame = 0, deadline = null, settleTimer = null;
  let available = false, hasVectorData = false, batchGood = 0, batchErrors = 0;
  let failedSinceData = false, lastNotice = 0;
  const pendingTiles = new Set(), listeners = [], sources = new Set();
  const abort = new AbortController();
  const emit = (callback, value) => { if (!destroyed) { try { callback?.(value); } catch {} } };
  const listen = (target, event, callback) => {
    target.on(event, callback); listeners.push(() => target.un(event, callback));
  };
  function fail(error) {
    if (destroyed) return;
    const alreadyFailed = failedSinceData && !available;
    available = false; failedSinceData = true;
    if (!alreadyFailed) emit(onError, error instanceof Error ? error : new Error('The map could not load.'));
  }
  function rendered() {
    if (destroyed || !hasVectorData || failedSinceData) return;
    clearTimeout(deadline);
    if (!available) { available = true; emit(onReady); }
  }
  function notice() {
    if (Date.now() - lastNotice < 5000) return;
    lastNotice = Date.now(); emit(onNotice, 'Part of the map could not load. You can retry.');
  }
  function settled() {
    if (destroyed || pendingTiles.size || !batchErrors) return;
    if (!batchGood) fail(new Error('Map data is unavailable. Check your connection and retry.'));
    else notice();
  }
  function watchSource(source, vector) {
    if (!source || sources.has(source)) return;
    sources.add(source);
    listen(source, 'tileloadstart', event => {
      if (destroyed) return;
      clearTimeout(settleTimer);
      if (!pendingTiles.size) { batchGood = 0; batchErrors = 0; }
      pendingTiles.add(event.tile);
    });
    listen(source, 'tileloadend', event => {
      if (destroyed) return;
      pendingTiles.delete(event.tile);
      // tileloadend also fires for aborted tiles; only LOADED is map data.
      if (event.tile?.getState?.() === TileState.LOADED) {
        batchGood++;
        if (vector) { hasVectorData = true; failedSinceData = false; }
      }
      clearTimeout(settleTimer); settleTimer = setTimeout(settled, 0);
      canvasMap.render();
    });
    listen(source, 'tileloaderror', event => {
      if (destroyed) return;
      pendingTiles.delete(event.tile); batchErrors++;
      clearTimeout(settleTimer); settleTimer = setTimeout(settled, 0);
    });
    listen(source, 'error', () => { if (!available) fail(new Error('The map source could not load.')); else notice(); });
  }
  function watchLayers(layer) {
    if (layer.getLayers) { layer.getLayers().forEach(watchLayers); return; }
    const source = layer.getSource?.();
    watchSource(source, source instanceof VectorTileSource);
  }
  function sync() {
    frame = 0;
    if (destroyed) return;
    const at = map.getCenter(), zoom = map.getZoom();
    const next = fromLonLat([at.lng, Math.max(-85.05112878, Math.min(85.05112878, at.lat))]);
    const previous = view.getCenter();
    if (!previous || previous[0] !== next[0] || previous[1] !== next[1]) view.setCenter(next);
    if (view.getZoom() !== zoom) view.setZoom(zoom);
    canvasMap.updateSize(); canvasMap.render();
  }
  function queueSync() {
    if (!destroyed && !frame) frame = requestAnimationFrame(sync);
  }
  map.on('move zoom resize', queueSync);
  listen(canvasMap, 'rendercomplete', rendered);
  deadline = setTimeout(() => {
    if (!available && !destroyed) fail(new Error('The map took too long to load. You can retry.'));
  }, LOAD_TIMEOUT);
  sync();

  // Fetch the provider's style once, and use generic fonts so this fallback has
  // no additional font CDN dependency. The geography and sprite source stay as
  // supplied by OpenFreeMap; styleUrl keeps any relative resource URLs correct.
  (async () => {
    try {
      const response = await fetch(STYLE_URL, { signal: abort.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('The map style could not load.');
      const style = await response.json();
      if (destroyed) return;
      for (const layer of style.layers || []) {
        if (layer.type === 'symbol' && layer.layout) layer.layout['text-font'] = ['sans-serif'];
      }
      await apply(group, style, { styleUrl: STYLE_URL });
      if (destroyed) { group.getLayers().clear(); return; }
      watchLayers(group);
      canvasMap.addLayer(group);
      sync();
    } catch (error) { if (!destroyed) fail(error); }
  })();

  return {
    resize: queueSync,
    destroy() {
      if (destroyed) return;
      destroyed = true; abort.abort();
      clearTimeout(deadline); clearTimeout(settleTimer); cancelAnimationFrame(frame); frame = 0;
      map.off('move zoom resize', queueSync);
      for (const remove of listeners) remove(); listeners.length = 0;
      pendingTiles.clear();
      canvasMap.setTarget(undefined); canvasMap.dispose();
      group.getLayers().clear();
      for (const source of sources) source.dispose?.(); sources.clear();
    },
  };
}
