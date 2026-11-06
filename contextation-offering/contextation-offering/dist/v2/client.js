export const $ = id => document.getElementById(id);
export const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const API = '/api/v2';

export class ApiError extends Error {
  constructor(message, status = 0, data = null) { super(message); this.name = 'ApiError'; this.status = status; this.data = data; }
}
export async function api(path, options = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), options.timeout || 12000);
  try {
    const init = { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal };
    delete init.timeout;
    if (init.body && typeof init.body !== 'string') {
      init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) }; init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path.startsWith('/api/') ? path : API + path, init);
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError(response.status === 401 ? 'Sign in again to continue.' : 'The room could not respond. Please try again.', response.status); }
    if (!response.ok) throw new ApiError(typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || 'That could not be completed. Please try again.', response.status, data);
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? 'The connection took too long. Please try again.' : 'The room is temporarily unreachable. Check your connection and try again.');
  } finally { clearTimeout(timeout); }
}
export function createPoller(task, interval = 1800) {
  let timer = null, active = false, running = false, again = false;
  async function run() {
    clearTimeout(timer); if (!active || document.hidden) return;
    if (running) { again = true; return; }
    running = true;
    try { await task(); } finally {
      running = false;
      if (active && !document.hidden) { timer = setTimeout(run, again ? 0 : interval); again = false; }
    }
  }
  function visibility() { clearTimeout(timer); if (!document.hidden) run(); }
  return {
    start() { if (!active) { active = true; document.addEventListener('visibilitychange', visibility); } run(); },
    refresh: run,
    stop() { active = false; again = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); },
  };
}
export function stateGate() {
  let current = null; const retired = new Set();
  return {
    get current() { return current; },
    accept(next) {
      if (!next?.sessionId || !next.phase || !Number.isFinite(next.revision)) throw new Error('The room could not be read. Please try again.');
      if (retired.has(next.sessionId)) return false;
      if (current) {
        if (next.sessionId === current.sessionId && next.revision < current.revision) return false;
        if ((next.sessionId !== current.sessionId || next.revision === current.revision) && Number(next.serverTime) < Number(current.serverTime)) return false;
        if (next.sessionId !== current.sessionId) retired.add(current.sessionId);
      }
      current = next; return true;
    },
  };
}
export function text(id, value) { const element = $(id), next = String(value ?? ''); if (element && element.textContent !== next) element.textContent = next; }
export function focusHeading(id) { const element = $(id); if (element) { element.tabIndex = -1; element.focus({ preventScroll: true }); } }
export function isTyping(target) { return target instanceof Element && (target.matches('input,textarea,select') || target.isContentEditable); }
export function roundOf(state) { return state?.round === 'hometown' || state?.phase?.startsWith('hometown') || state?.phase === 'complete' ? 'hometown' : 'local'; }
export function isOpen(state, round = roundOf(state)) { return state?.phase === round + '_open'; }
export function cleanName(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40); }
export function validPlace(place) { return Boolean(place && typeof place.lat === 'number' && typeof place.lng === 'number' && Number.isFinite(place.lat) && Number.isFinite(place.lng) && Math.abs(place.lat) <= 85 && Math.abs(place.lng) <= 180); }
export function normalizePlace(raw, round, home = false, customLabel = '', centerLatitude = 43.0421035) {
  if (!validPlace(raw)) return null;
  if (round === 'local' && home) {
    const metresPerDegree = Math.PI * 6371008.8 / 180, xScale = metresPerDegree * Math.cos(centerLatitude * Math.PI / 180);
    const center = value => (Math.floor(value / 500) + .5) * 500;
    return { label: 'a neighborhood', lat: Number((center(raw.lat * metresPerDegree) / metresPerDegree).toFixed(6)), lng: Number((center(raw.lng * xScale) / xScale).toFixed(6)), kind: 'home', approximate: true, source: 'map', precision: 'approximate' };
  }
  const place = {
    label: String(customLabel || raw.label || 'A chosen place').trim().slice(0, 160), lat: raw.lat, lng: raw.lng,
    kind: round === 'hometown' ? 'town' : 'place', approximate: Boolean(raw.approximate),
    detail: String(raw.detail || '').slice(0, 240), source: String(raw.source || 'map').slice(0, 40),
    precision: String(raw.precision || (round === 'hometown' ? 'town' : 'point')).slice(0, 40),
  };
  if (typeof raw.selectionToken === 'string') place.selectionToken = raw.selectionToken;
  return place;
}
export function placeDescription(place) {
  if (!place) return '';
  if (place.source === 'example-catalog') return 'example place for rehearsal';
  if (place.approximate || place.kind === 'home' || place.precision === 'approximate') return 'approximate area · the original address is not shared';
  const source = place.source === 'photon' ? 'OpenStreetMap search' : 'participant-chosen map point';
  const precision = place.precision === 'town' || place.kind === 'town' ? 'town or city location' : place.precision === 'address' ? 'address location' : 'point location';
  return source + ' · ' + precision;
}
export function liveResults(result) {
  if (/example|catalog|builtin|fallback|unavailable/i.test(result?.source || '')) return null;
  return (Array.isArray(result?.results) ? result.results : []).filter(place => validPlace(place) && !/example|catalog|builtin/i.test(place.source || '')).slice(0, 8);
}
export function renderResults(container, places, choose) {
  const fragment = document.createDocumentFragment();
  for (const place of places) {
    const item = document.createElement('li'), button = document.createElement('button'), label = document.createElement('span');
    button.type = 'button'; button.className = 'place-result'; label.textContent = place.label; button.append(label);
    if (place.detail) { const detail = document.createElement('small'); detail.textContent = place.detail; button.append(detail); }
    button.addEventListener('click', () => choose(place)); item.append(button); fragment.append(item);
  }
  container.replaceChildren(fragment);
}
export function mapStatus(message, detail) {
  if (message && typeof message === 'object') return { ...message, message: message.message || '' };
  return { ...detail, message: String(message || '') };
}
export function elapsedTime(state, now = Date.now()) {
  const clock = state?.clock || {}, duration = Number(clock.durationMs) || 0;
  const start = typeof clock.startedAt === 'number' ? clock.startedAt : Date.parse(clock.startedAt);
  const elapsed = Math.max(0, Number(clock.elapsedMs) || 0) + (!clock.paused && Number.isFinite(start) ? Math.max(0, now - start) : 0);
  return Math.min(duration || elapsed, elapsed);
}
