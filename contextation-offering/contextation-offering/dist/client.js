export const $ = id => document.getElementById(id);
export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ApiError extends Error {
  constructor(message, status = 0, data = null) { super(message); this.name = 'ApiError'; this.status = status; this.data = data; }
}

export async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 12000);
  try {
    const init = { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal };
    delete init.timeout;
    if (init.body && typeof init.body !== 'string') {
      init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path, init);
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError(response.status === 401 ? 'Sign in again to continue.' : 'The room could not respond. Try again.', response.status); }
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new ApiError(detail || data.message || 'That could not be completed. Try again.', response.status, data);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError('The connection took too long. Try again.');
    if (error instanceof ApiError) throw error;
    throw new ApiError('The room is temporarily unreachable. Check your connection.');
  } finally { window.clearTimeout(timeout); }
}

export function createPoller(task, interval = 1500) {
  let timer = null, stopped = true, running = false, pending = false, listening = false;
  function schedule() {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(run, document.hidden ? Math.max(15000, interval * 8) : interval);
  }
  async function run() {
    if (stopped) return;
    if (running) { pending = true; return; }
    running = true;
    try { await task(); }
    finally {
      running = false;
      if (stopped) return;
      if (pending) { pending = false; clearTimeout(timer); timer = setTimeout(run, 0); }
      else schedule();
    }
  }
  function onVisibility() { if (document.hidden) schedule(); else { clearTimeout(timer); run(); } }
  return {
    start() { stopped = false; if (!listening) { document.addEventListener('visibilitychange', onVisibility); listening = true; } run(); },
    refresh() { if (!stopped) { clearTimeout(timer); run(); } },
    stop() { stopped = true; pending = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); listening = false; }
  };
}

export function setText(id, value) { const el = $(id), text = String(value ?? ''); if (el && el.textContent !== text) el.textContent = text; }
export function focusHeading(id) { const el = $(id); if (el) { el.tabIndex = -1; el.focus({ preventScroll: true }); } }
export function isTyping(target) { return target instanceof Element && (target.matches('input, textarea, select') || target.isContentEditable); }
export function validPlace(place) { return Boolean(place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng)) && Number(place.lat) >= -85 && Number(place.lat) <= 85 && Number(place.lng) >= -180 && Number(place.lng) <= 180); }
export function normalizePlace(raw, round, kind, customLabel) {
  const home = round === 'local' && kind === 'home';
  return {
    label: home ? 'A neighborhood' : String(customLabel || raw.label || 'A chosen place').trim().slice(0, 120),
    lat: home ? Number(Number(raw.lat).toFixed(2)) : Number(raw.lat),
    lng: home ? Number(Number(raw.lng).toFixed(2)) : Number(raw.lng),
    kind: home ? 'home' : round === 'hometown' ? 'town' : 'place',
    approximate: home || Boolean(raw.approximate)
  };
}

// Never silently present rehearsal examples as live geographic search results.
export function liveResults(result) {
  if (/example|catalog|builtin|fallback/i.test(result?.source || '')) return null;
  return (Array.isArray(result?.results) ? result.results : [])
    .filter(item => validPlace(item) && !/example|catalog|builtin/i.test(item.source || '')).slice(0, 8);
}
export function renderResults(container, items, onSelect) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const li = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.className = 'search-result';
    const label = document.createElement('span'); label.className = 'result-label'; label.textContent = item.label;
    button.append(label);
    if (item.detail) { const detail = document.createElement('span'); detail.className = 'result-detail'; detail.textContent = item.detail; button.append(detail); }
    button.addEventListener('click', () => onSelect(item));
    li.append(button); fragment.append(li);
  }
  container.replaceChildren(fragment);
}
