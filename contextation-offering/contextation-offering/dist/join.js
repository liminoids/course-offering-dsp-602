import { $, api, createPoller, setText, focusHeading, validPlace, normalizePlace, liveResults, renderResults, reducedMotion } from './client.js';

let state = null, config = null, view = 'loading-view', round = 'local', mode = 'search';
let selection = null, publicLabel = '', editing = false, renaming = false, saving = false, searching = false;
let searchSequence = 0, selectionMap = null, mapLoading = false, mapFailed = false, nameTouched = false, initialized = false;
const retiredSessions = new Set();
try { $('display-name').value = (sessionStorage.getItem('offering-name') || '').slice(0, 40); } catch {}

function name() { return $('display-name').value.replace(/\s+/g, ' ').trim().slice(0, 40); }
function open() { return state?.phase === round + '_open'; }
function own() { return state?.own?.[round] || null; }
function kind() { return round === 'hometown' ? 'town' : $('private-home').checked ? 'home' : 'place'; }
function place() { return normalizePlace(selection, round, kind(), $('place-label').value); }
function setMapPlace(value) { (selectionMap?.setSelection || selectionMap?.setPlace)?.call(selectionMap, value); }
function show(id, heading) {
  const changed = view !== id;
  for (const candidate of ['loading-view', 'entry-view', 'quiet-view']) $(candidate).hidden = candidate !== id;
  view = id;
  if (changed) { window.scrollTo({ top: 0, behavior: 'instant' }); if (heading) focusHeading(heading); }
  if (id === 'entry-view' && mode === 'map') { ensureMap(); requestAnimationFrame(() => selectionMap?.resize?.()); }
}
function syncInputs() {
  const locked = saving || !open();
  for (const id of ['display-name', 'place-search', 'private-home', 'share-consent', 'search-mode', 'map-mode', 'rename-place', 'cancel-edit']) $(id).disabled = locked;
  $('place-label').disabled = locked || kind() === 'home';
  $('search-button').disabled = locked || searching;
  $('submit-place').disabled = locked || !selection;
  setText('submit-place', saving ? 'Submitting…' : 'Submit');
}
function clearSelection() {
  selection = null; publicLabel = ''; renaming = false; searching = false; searchSequence++;
  $('place-label').value = ''; $('place-search').value = ''; $('share-consent').checked = false;
  $('search-results').replaceChildren(); $('review').hidden = true; $('label-editor').hidden = true;
  setText('search-status', ''); setText('submit-status', ''); setMapPlace(null);
}
function setMode(next) {
  mode = next;
  $('search-mode').setAttribute('aria-pressed', String(mode === 'search'));
  $('map-mode').setAttribute('aria-pressed', String(mode === 'map'));
  $('search-pane').hidden = mode !== 'search'; $('map-pane').hidden = mode !== 'map';
  if (mode === 'map') { ensureMap(); requestAnimationFrame(() => selectionMap?.resize?.()); }
}
async function ensureMap() {
  if (selectionMap || mapLoading || mapFailed || !config || mode !== 'map') return;
  mapLoading = true;
  try {
    const maps = await import('./map.js');
    selectionMap = await maps.createSelectionMap($('selection-map'), {
      config, round,
      onSelect(raw) { if (raw && raw.lng === undefined && Number.isFinite(raw.lon)) raw = { ...raw, lng: raw.lon }; choose(raw, false); },
      onStatus(message, detail) {
        if (detail?.state === 'unavailable') setText('map-caption', 'The map is unavailable. Use search instead.');
        else if (detail?.available) setText('map-caption', 'Choose a point.');
        else if (message) setText('map-caption', message);
      }
    });
    selectionMap?.setRound?.(round);
    if (selection) setMapPlace(place());
    requestAnimationFrame(() => selectionMap?.resize?.());
  } catch { mapFailed = true; setText('map-caption', 'The map is unavailable. Use search instead.'); }
  finally { mapLoading = false; }
}
function review(moveMap = false) {
  if (!selection) return;
  const home = kind() === 'home';
  if (home) $('place-label').value = 'A neighborhood';
  const selected = place();
  setText('chosen-summary', `${selected.label} · ${name() || 'Anonymous'}`);
  setText('share-details', home ? 'Only a rounded area is shared; your address is not shown.' : 'This place and name will appear on the shared map.');
  $('rename-place').hidden = home; $('label-editor').hidden = home || !renaming;
  $('rename-place').setAttribute('aria-expanded', String(renaming && !home));
  $('review').hidden = false; $('cancel-edit').hidden = !own();
  syncInputs();
  if (moveMap) setMapPlace(selected);
}
function choose(raw, moveFocus = true) {
  if (!open() || saving || !validPlace(raw)) return;
  selection = { ...raw, label: String(raw.label || raw.name || 'A chosen place').slice(0, 120), lat: Number(raw.lat), lng: Number(raw.lng) };
  publicLabel = selection.label; $('place-label').value = publicLabel; $('share-consent').checked = false;
  renaming = false; searchSequence++; searching = false;
  $('search-results').replaceChildren(); setText('search-status', ''); setText('submit-status', '');
  review(true);
  if (moveFocus) { $('review').scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth' }); $('chosen-summary').focus({ preventScroll: true }); }
}
function render() {
  if (!state || !config) return;
  const hometown = round === 'hometown';
  setText('place-title', hometown ? 'Where are you from?' : 'Choose a place.');
  setText('round-note', hometown ? 'A hometown, or another place you carry with you.' : 'Somewhere within about 40 miles of Syracuse.');
  setText('search-label', hometown ? 'Find a town or city' : 'Find a local place');
  $('place-search').placeholder = hometown ? 'Town, state or country' : 'Place name or address';
  $('home-option').hidden = hometown;
  const entry = own();
  if (open() && (!entry || editing)) {
    show('entry-view', 'place-title'); $('cancel-edit').hidden = !entry;
    if (selection) review(); syncInputs(); return;
  }
  editing = false;
  const complete = state.phase === 'complete';
  setText('quiet-title', complete ? 'Thank you.' : entry ? 'Your place is held.' : 'Look up.');
  setText('quiet-place', entry?.place.label || ''); $('quiet-place').hidden = !entry;
  setText('quiet-copy', complete ? 'You can set your screen aside.' : entry ? 'Look up when you’re ready.' : 'The shared view is unfolding.');
  $('edit-place').hidden = !open() || !entry;
  show('quiet-view', 'quiet-title');
}
function acceptState(next) {
  if (!next?.phase || !next.sessionId) throw new Error('The room could not be read.');
  if (retiredSessions.has(next.sessionId)) return false;
  if (state?.sessionId === next.sessionId && next.revision < state.revision) return false;
  const nextRound = next.round === 'hometown' || next.phase.startsWith('hometown') || next.phase === 'complete' ? 'hometown' : 'local';
  const newSession = state && state.sessionId !== next.sessionId;
  const newInvitation = state && state.phase !== next.phase && next.phase.endsWith('_open');
  if (newSession) retiredSessions.add(state.sessionId);
  if (newSession || nextRound !== round || newInvitation) {
    editing = false; clearSelection(); $('private-home').checked = false;
  } else if (state && state.phase !== next.phase && !next.phase.endsWith('_open')) { editing = false; searchSequence++; searching = false; }
  if (nextRound !== round) { round = nextRound; selectionMap?.setRound?.(round); }
  if (!initialized && !nameTouched) {
    const previous = next.own?.hometown || next.own?.local;
    if (previous) $('display-name').value = previous.displayName || '';
  }
  initialized = true; state = next; config = next.config || config; render(); return true;
}
async function refresh() {
  try {
    const next = await api('/api/state');
    if (!next.config && !config) config = await api('/api/config');
    acceptState(next); $('connection-error').hidden = true;
  } catch (error) { setText('connection-message', error.message); $('connection-error').hidden = false; }
}
const poller = createPoller(refresh);

async function search() {
  if (!open() || saving) return;
  const query = $('place-search').value.trim();
  if (query.length < 2) { setText('search-status', 'Enter a place name or address.'); $('place-search').focus(); return; }
  const token = ++searchSequence, requestedRound = round, session = state.sessionId;
  searching = true; syncInputs(); $('search-results').replaceChildren(); setText('search-status', 'Searching…');
  try {
    const result = await api(`/api/search?${new URLSearchParams({ q: query, round: requestedRound })}`, { timeout: 14000 });
    if (token !== searchSequence || session !== state?.sessionId || round !== requestedRound || !open()) return;
    const results = liveResults(result);
    if (results === null) { setText('search-status', 'Search is unavailable right now. Try the map.'); return; }
    renderResults($('search-results'), results, choose);
    setText('search-status', results.length ? 'Choose the place you mean.' : 'No matching places. Try a more specific name or the map.');
  } catch { if (token === searchSequence) setText('search-status', 'Search is unavailable right now. Try again or use the map.'); }
  finally { if (token === searchSequence) { searching = false; syncInputs(); } }
}
$('search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
$('search-mode').addEventListener('click', () => setMode('search'));
$('map-mode').addEventListener('click', () => setMode('map'));
$('retry-connection').addEventListener('click', () => poller.refresh());
$('display-name').addEventListener('input', () => { nameTouched = true; $('share-consent').checked = false; try { sessionStorage.setItem('offering-name', $('display-name').value); } catch {} review(); });
$('private-home').addEventListener('change', () => {
  if ($('private-home').checked) publicLabel = $('place-label').value;
  else $('place-label').value = publicLabel || selection?.label || '';
  $('share-consent').checked = false; review(true);
});
$('rename-place').addEventListener('click', () => { renaming = !renaming; review(); if (renaming) $('place-label').focus(); });
$('place-label').addEventListener('input', () => { publicLabel = $('place-label').value; $('share-consent').checked = false; review(); });
$('submit-place').addEventListener('click', async () => {
  if (saving || !open() || !validPlace(selection)) return;
  if (!$('place-label').value.trim()) { renaming = true; review(); setText('submit-status', 'Give your place a short label.'); $('place-label').focus(); return; }
  if (!$('share-consent').checked) { setText('submit-status', 'Confirm you’re okay sharing the place and name above.'); $('share-consent').focus(); return; }
  const payload = { sessionId: state.sessionId, round, displayName: name(), place: place() };
  saving = true; syncInputs(); setText('submit-status', '');
  try {
    const result = await api('/api/contributions', { method: 'POST', body: payload });
    if (state?.sessionId === payload.sessionId && round === payload.round) { editing = false; clearSelection(); }
    if (result.state) acceptState(result.state); else await refresh();
    poller.refresh();
  } catch (error) { setText('submit-status', `Your place hasn’t been confirmed. ${error.message}`); if (error.status === 409) poller.refresh(); }
  finally { saving = false; syncInputs(); }
});
$('edit-place').addEventListener('click', () => {
  if (!open() || !own()) { poller.refresh(); return; }
  editing = true; const entry = own(); $('private-home').checked = entry.place.kind === 'home';
  render(); choose(entry.place, false);
});
$('cancel-edit').addEventListener('click', () => { if (!saving) { editing = false; clearSelection(); render(); } });
window.addEventListener('pagehide', () => poller.stop());
window.addEventListener('pageshow', event => { if (event.persisted) poller.start(); });
poller.start();
