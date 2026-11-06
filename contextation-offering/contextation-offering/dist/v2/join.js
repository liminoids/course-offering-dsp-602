import { $, api, createPoller, stateGate, text, focusHeading, roundOf, isOpen, cleanName, validPlace, normalizePlace, placeDescription, liveResults, renderResults, mapStatus, motion } from './client.js';

const gate = stateGate();
let state = null, config = null, round = 'local', view = 'loading-view', mode = 'map';
let selection = null, publicLabel = '', renaming = false, editing = false, editingName = false;
let saving = false, joining = false, removing = false, searching = false, searchSequence = 0;
let selectionMap = null, mapLoading = false, mapFailed = false, removeContext = null;
try { $('display-name').value = (sessionStorage.getItem('offering-v2-name') || '').slice(0, 40); } catch {}

const open = () => isOpen(state, round);
const own = () => state?.own?.[round] || null;
const home = () => round === 'local' && $('private-home').checked;
const privateSelection = () => round === 'local' && (selection?.kind === 'home' || selection?.precision === 'address');
const verifiedSelection = () => Boolean(selection?.selectionToken);
const place = () => normalizePlace(selection, round, home(), $('place-label').value, config?.center?.lat);
function setMapPlace(value) { (selectionMap?.setSelection || selectionMap?.setPlace)?.call(selectionMap, value); }
function report(message) { text('connection-message', message); $('connection-error').hidden = !message; }
function show(next, heading) {
  const changed = view !== next;
  for (const id of ['loading-view', 'name-view', 'place-view', 'held-view']) $(id).hidden = id !== next;
  for (const step of ['loading', 'name', 'place', 'held']) document.body.classList.toggle('is-' + step, next === step + '-view');
  view = next;
  $('selection-map').inert = next !== 'place-view' || mode === 'search';
  $('selection-map').setAttribute('aria-hidden', String(next !== 'place-view' || mode === 'search'));
  if (changed && heading) focusHeading(heading);
  if (next === 'place-view') requestAnimationFrame(() => selectionMap?.resize?.());
}
function syncInputs() {
  const locked = saving || removing || !open() || !state?.member;
  for (const id of ['place-search', 'private-home', 'share-consent', 'search-mode', 'map-mode', 'rename-place', 'cancel-edit']) $(id).disabled = locked;
  $('private-home').disabled = locked || privateSelection();
  $('place-label').disabled = locked || home() || verifiedSelection();
  $('search-button').disabled = locked || searching;
  $('share-place').disabled = locked || !selection;
  text('share-place', saving ? 'sharing…' : 'share this place');
  for (const id of ['display-name', 'continue-name', 'anonymous-name', 'cancel-name']) $(id).disabled = joining;
  $('change-name').disabled = joining || saving || removing;
  text('continue-name', joining ? 'one moment…' : 'continue');
  $('confirm-remove').disabled = removing; $('cancel-remove').disabled = removing;
}
function clearSelection() {
  selection = null; publicLabel = ''; renaming = false; searching = false; searchSequence++;
  $('place-label').value = ''; $('place-search').value = ''; $('private-home').checked = false; $('share-consent').checked = false;
  $('search-results').replaceChildren(); $('place-review').hidden = true; $('label-editor').hidden = true;
  text('search-status', ''); text('submit-error', ''); setMapPlace(null);
}
function setMode(next, focus = false) {
  mode = next; document.body.classList.toggle('is-search', mode === 'search');
  $('selection-map').inert = view !== 'place-view' || mode === 'search';
  $('selection-map').setAttribute('aria-hidden', String(view !== 'place-view' || mode === 'search'));
  $('map-mode').setAttribute('aria-pressed', String(mode === 'map')); $('search-mode').setAttribute('aria-pressed', String(mode === 'search'));
  $('search-pane').hidden = mode !== 'search'; $('map-hint').hidden = mode !== 'map';
  if (mode === 'map') { ensureMap(); requestAnimationFrame(() => selectionMap?.resize?.()); }
  else if (focus) $('place-search').focus();
}
async function ensureMap() {
  if (selectionMap || mapLoading || mapFailed || !config) return;
  mapLoading = true;
  try {
    const maps = await import('./map.js');
    selectionMap = await maps.createSelectionMap($('selection-map'), {
      config, round,
      onSelect(raw) { if (raw && raw.lng === undefined && Number.isFinite(raw.lon)) raw = { ...raw, lng: raw.lon }; choose(raw, false); },
      onStatus(message, detail) {
        const status = mapStatus(message, detail);
        const unavailable = status.state === 'unavailable' || status.state === 'error' && !status.available;
        const copy = unavailable ? 'the map is unavailable. you can use search.' : status.available ? '' : status.message;
        text('map-feedback', copy); $('map-feedback').hidden = !copy;
      },
    });
    selectionMap?.setRound?.(round); if (selection) setMapPlace(place());
    requestAnimationFrame(() => selectionMap?.resize?.());
  } catch { mapFailed = true; text('map-feedback', 'the map is unavailable. you can use search.'); $('map-feedback').hidden = false; }
  finally { mapLoading = false; }
}
function review(moveMap = false) {
  if (!selection) return;
  if (home()) $('place-label').value = 'A neighborhood';
  const selected = place();
  text('chosen-label', selected.label); text('chosen-person', state?.member?.displayName || 'anonymous');
  text('precision-note', privateSelection() ? 'addresses are shared as an approximate area. the original address is not shared.' : placeDescription(selected));
  $('rename-place').hidden = home() || verifiedSelection(); $('label-editor').hidden = home() || verifiedSelection() || !renaming;
  $('rename-place').setAttribute('aria-expanded', String(renaming && !home()));
  $('place-review').hidden = false; $('cancel-edit').hidden = !own(); syncInputs();
  if (moveMap) setMapPlace(selected);
}
function choose(raw, moveFocus = true) {
  if (!open() || saving || !state?.member || !validPlace(raw)) return;
  selection = { ...raw, label: String(raw.label || raw.name || 'A chosen place').slice(0, 160) };
  publicLabel = selection.label; $('place-label').value = publicLabel;
  $('private-home').checked = round === 'local' && (selection.kind === 'home' || selection.precision === 'address');
  $('share-consent').checked = false; renaming = false; searchSequence++; searching = false;
  $('search-results').replaceChildren(); text('search-status', ''); text('submit-error', '');
  review(true);
  if (moveFocus) { $('place-review').scrollIntoView({ block: 'nearest', behavior: motion.matches ? 'instant' : 'smooth' }); focusHeading('chosen-label'); }
  else text('join-announcement', selectedAnnouncement());
}
function selectedAnnouncement() { const selected = place(); return selected ? selected.label + ' selected. Review it before sharing.' : ''; }
function render() {
  if (!state || !config) return;
  const hometown = round === 'hometown', entry = own();
  $('change-name').hidden = !state.member || editingName || state.phase === 'complete';
  $('cancel-name').hidden = !state.member;
  text('place-title', hometown ? 'a place you carry.' : 'a place near you.');
  text('round-note', hometown ? 'a hometown, or somewhere you came from' : 'somewhere within about 40 miles of Syracuse');
  text('search-label', hometown ? 'find a town or city' : 'find a nearby place');
  $('place-search').placeholder = hometown ? 'town, state or country' : 'place name or address';
  $('home-option').hidden = hometown;
  if ((!state.member || editingName) && state.phase !== 'complete') { show('name-view', 'name-title'); syncInputs(); ensureMap(); return; }
  if (open() && (!entry || editing)) {
    show('place-view', 'place-title'); $('cancel-edit').hidden = !entry;
    if (selection) review(); syncInputs(); ensureMap(); return;
  }
  editing = false;
  text('held-title', state.phase === 'complete' ? 'here, together.' : entry ? 'held.' : 'look up.');
  text('held-copy', state.phase === 'complete' ? 'you can set your screen aside.' : entry ? 'look up.' : 'the room is unfolding.');
  text('held-place', entry?.place?.label || ''); $('held-place').hidden = !entry;
  $('edit-place').hidden = !open() || !entry; $('remove-place').hidden = !open() || !entry;
  show('held-view', 'held-title'); syncInputs(); ensureMap();
}
function acceptState(next) {
  const previous = state;
  if (!gate.accept(next)) return false;
  const nextRound = roundOf(next), reset = previous && previous.sessionId !== next.sessionId;
  const changedRound = nextRound !== round;
  state = next; config = next.config || config; round = nextRound;
  if (reset || changedRound) {
    editing = false; editingName = false; clearSelection(); selectionMap?.setRound?.(round);
    if ($('remove-dialog').open) $('remove-dialog').close();
    text('name-error', '');
    text('join-announcement', reset ? 'The room was cleared. You can join again.' : 'The hometown invitation is open.');
  }
  if (previous?.member?.displayName !== state.member?.displayName) $('share-consent').checked = false;
  if (!open()) { editing = false; searchSequence++; searching = false; }
  render(); return true;
}
async function refresh() {
  try {
    const next = await api('/state'); if (!next.config && !config) next.config = await api('/config');
    acceptState(next); report('');
  } catch (error) { report(error.message); }
}
const poller = createPoller(refresh, 2200);
async function join(anonymous) {
  if (joining || !state) return;
  const sessionId = state.sessionId, displayName = anonymous ? '' : cleanName($('display-name').value);
  joining = true; text('name-error', ''); syncInputs();
  try {
    const result = await api('/join', { method: 'POST', body: { sessionId, displayName } });
    if (state?.sessionId !== sessionId) return;
    editingName = false; $('display-name').value = displayName;
    try { if (displayName) sessionStorage.setItem('offering-v2-name', displayName); else sessionStorage.removeItem('offering-v2-name'); } catch {}
    if (result.state) acceptState(result.state); else await refresh();
    poller.refresh();
  } catch (error) { text('name-error', error.message); if (error.status === 409) poller.refresh(); }
  finally { joining = false; render(); }
}
async function search() {
  if (!open() || saving || !state?.member) return;
  const query = $('place-search').value.trim();
  if (query.length < 2) { text('search-status', 'enter a place name or address.'); $('place-search').focus(); return; }
  const sequence = ++searchSequence, sessionId = state.sessionId, searchedRound = round;
  searching = true; syncInputs(); $('search-results').replaceChildren(); text('search-status', 'looking…');
  try {
    const result = await api('/search?' + new URLSearchParams({ q: query, round: searchedRound }), { timeout: 14000 });
    if (sequence !== searchSequence || state?.sessionId !== sessionId || round !== searchedRound || !open()) return;
    const results = liveResults(result);
    if (results === null) { text('search-status', result.notice || 'search is unavailable right now. try the map or try again.'); return; }
    renderResults($('search-results'), results, raw => choose(raw));
    text('search-status', results.length ? 'choose the place you mean.' : round === 'local' ? 'no matching places within 40 miles. try a more specific name or use the map.' : 'no matching places. try a town and country.');
  } catch (error) { if (sequence === searchSequence) text('search-status', error.message); }
  finally { if (sequence === searchSequence) { searching = false; syncInputs(); } }
}
async function submit() {
  if (saving || !open() || !state?.member || !validPlace(selection)) return;
  if (!$('place-label').value.trim()) { text('submit-error', 'give this place a short label.'); $('place-label').focus(); return; }
  if (!$('share-consent').checked) { text('submit-error', 'confirm the place and name above before sharing.'); $('share-consent').focus(); return; }
  const payload = { sessionId: state.sessionId, round, displayName: state.member.displayName || '', place: place() };
  saving = true; syncInputs(); text('submit-error', '');
  try {
    const result = await api('/contributions', { method: 'POST', body: payload });
    if (state?.sessionId === payload.sessionId && round === payload.round) { editing = false; clearSelection(); }
    if (result.state) acceptState(result.state); else await refresh();
    poller.refresh();
  } catch (error) { text('submit-error', error.message); if (error.status === 409) poller.refresh(); }
  finally { saving = false; render(); }
}
$('continue-name').addEventListener('click', () => join(false));
$('anonymous-name').addEventListener('click', () => join(true));
$('display-name').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); join(false); } });
$('change-name').addEventListener('click', () => { if (!state?.member || saving) return; editingName = true; $('display-name').value = state.member.displayName || ''; text('name-error', ''); render(); $('display-name').focus(); });
$('cancel-name').addEventListener('click', () => { if (!joining) { editingName = false; render(); } });
$('map-mode').addEventListener('click', () => setMode('map'));
$('search-mode').addEventListener('click', () => setMode('search', true));
$('search-button').addEventListener('click', search);
$('place-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
$('rename-place').addEventListener('click', () => { renaming = !renaming; review(); if (renaming) $('place-label').focus(); });
$('place-label').addEventListener('input', () => { publicLabel = $('place-label').value; $('share-consent').checked = false; review(true); });
$('private-home').addEventListener('change', () => {
  if (home()) publicLabel = $('place-label').value; else $('place-label').value = publicLabel || selection?.label || '';
  $('share-consent').checked = false; review(true);
});
$('share-place').addEventListener('click', submit);
$('edit-place').addEventListener('click', () => { if (!open() || !own()) return; editing = true; render(); choose(own().place, false); });
$('cancel-edit').addEventListener('click', () => { if (!saving) { editing = false; clearSelection(); render(); } });
$('remove-place').addEventListener('click', () => {
  if (!open() || !own()) return;
  removeContext = { sessionId: state.sessionId, round, entryId: own().id }; text('remove-error', ''); $('remove-dialog').showModal();
});
$('cancel-remove').addEventListener('click', () => { if (!removing) $('remove-dialog').close(); });
$('remove-dialog').addEventListener('cancel', event => { if (removing) event.preventDefault(); });
$('confirm-remove').addEventListener('click', async () => {
  if (removing || !removeContext) return;
  const captured = { ...removeContext };
  if (state?.sessionId !== captured.sessionId || round !== captured.round || own()?.id !== captured.entryId || !open()) { text('remove-error', 'the invitation changed. close this window and check your place.'); return; }
  removing = true; syncInputs(); text('remove-error', '');
  try {
    const result = await api('/contributions?' + new URLSearchParams({ sessionId: captured.sessionId, round: captured.round }), { method: 'DELETE' });
    if (state?.sessionId === captured.sessionId) { clearSelection(); editing = false; }
    if (result.state) acceptState(result.state); else await refresh();
    $('remove-dialog').close(); poller.refresh();
  } catch (error) { text('remove-error', error.message); if (error.status === 409) poller.refresh(); }
  finally { removing = false; render(); }
});
$('retry-connection').addEventListener('click', () => { mapFailed = false; poller.refresh(); ensureMap(); });
window.addEventListener('resize', () => selectionMap?.resize?.());
window.addEventListener('pagehide', () => poller.stop());
window.addEventListener('pageshow', event => { if (event.persisted) poller.start(); });
setMode('map'); poller.start();
