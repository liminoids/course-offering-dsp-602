import { $, api, createPoller, setText, isTyping, validPlace, normalizePlace, liveResults, renderResults } from './client.js';

let state = null, presentation = null, mapLoading = false, mapFailed = false, mapUnavailable = false;
let busy = false, controlsVisible = true, moreVisible = false, listVisible = false, lastList = '', statusTimer = null, leaving = false;
const retiredSessions = new Set();
const assisted = { round: null, sessionId: null, place: null, publicLabel: '', sequence: 0, searching: false, submitting: false };
const phases = {
  local_open: { label: 'Nearby · gathering', action: 'start_local', button: 'Begin' },
  local_reveal: { label: 'Nearby', action: 'open_hometown', button: 'Invite hometowns' },
  local_rest: { label: 'Nearby', action: 'open_hometown', button: 'Invite hometowns' },
  hometown_open: { label: 'Hometowns · gathering', action: 'start_hometown', button: 'Begin' },
  hometown_reveal: { label: 'Hometowns', action: 'finish', button: 'Finish' },
  hometown_rest: { label: 'Hometowns', action: 'finish', button: 'Finish' },
  complete: { label: 'Here, together', action: null, button: 'Finished' }
};
function signIn() { if (leaving) return; leaving = true; poller.stop(); window.location.assign('/_gate/login?next=%2F'); }
function error(message) { setText('host-error', message); $('host-error').hidden = false; }
function clearError() { $('host-error').hidden = true; }
function dismissHints() { $('key-hints').hidden = true; }
function status(message) { clearTimeout(statusTimer); setText('control-status', message); statusTimer = setTimeout(() => setText('control-status', ''), 5000); }
function setMore(visible) { moreVisible = visible; $('more-panel').hidden = !visible; $('more-toggle').setAttribute('aria-expanded', String(visible)); }
function setControls(visible, moveFocus = false) {
  controlsVisible = visible; $('host-controls').hidden = !visible; $('show-controls').hidden = visible;
  if (!visible) setMore(false);
  if (moveFocus) (visible ? $('primary-control').hidden ? $('more-toggle') : $('primary-control') : $('show-controls')).focus();
}
function updateList() {
  const visible = listVisible || mapUnavailable;
  $('place-list-panel').hidden = !visible; $('close-place-list').hidden = mapUnavailable;
  $('list-control').setAttribute('aria-expanded', String(visible)); setText('list-control', listVisible ? 'Hide places' : 'Show places');
  if (!state) return;
  const round = state.round === 'hometown' || state.phase === 'complete' ? 'hometown' : 'local';
  setText('place-list-title', round === 'hometown' ? 'Hometowns' : 'Nearby places');
  const entries = state.entries.filter(entry => entry.round === round);
  const signature = JSON.stringify(entries);
  if (lastList === signature) return;
  lastList = signature;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const li = document.createElement('li'); li.append(document.createTextNode(entry.place.label));
    const name = document.createElement('span'); name.textContent = (entry.displayName || 'Anonymous') + (entry.isExample ? ' · example' : '');
    li.append(name); fragment.append(li);
  }
  if (!entries.length) { const li = document.createElement('li'); li.textContent = 'No places yet.'; fragment.append(li); }
  $('place-list').replaceChildren(fragment);
}
function mapStatus(message, detail) {
  setText('map-status', message || '');
  if (detail?.state === 'unavailable') mapUnavailable = true;
  if (detail?.available) mapUnavailable = false;
  updateList();
}
async function ensureMap() {
  if (presentation || mapLoading || mapFailed || !state?.config) return;
  mapLoading = true;
  try {
    const maps = await import('./map.js');
    presentation = await maps.createPresentationMap($('presentation-map'), { config: state.config, onStatus: mapStatus });
    presentation?.update?.(state);
  } catch { mapFailed = true; mapUnavailable = true; setText('map-status', 'Map unavailable. The places are listed instead.'); updateList(); }
  finally { mapLoading = false; }
}
function render() {
  if (!state) return;
  const info = phases[state.phase] || phases.local_open;
  const round = state.round === 'hometown' || state.phase === 'complete' ? 'hometown' : 'local';
  const count = state.counts?.[round] || 0;
  setText('room-phase', state.phase.endsWith('_reveal') && state.clock?.paused ? 'Paused' : info.label);
  setText('ready-count', `${count} ${count === 1 ? 'place' : 'places'}`);
  $('example-note').hidden = !state.demoMode && !state.entries.some(entry => entry.isExample);
  setText('primary-control', info.button); $('primary-control').dataset.action = info.action || ''; $('primary-control').hidden = !info.action;
  $('primary-control').disabled = busy || !info.action || (['start_local', 'start_hometown'].includes(info.action) && count === 0);
  $('pause-control').hidden = !state.phase.endsWith('_reveal'); $('pause-control').disabled = busy;
  setText('pause-control', state.clock?.paused ? 'Resume' : 'Pause');
  $('reset-control').disabled = busy; $('confirm-reset').disabled = busy;
  $('add-place-control').disabled = busy || !state.phase.endsWith('_open');
  updateList(); syncAssisted(); ensureMap();
  try { presentation?.update?.(state); }
  catch { mapUnavailable = true; updateList(); }
}
function acceptState(next) {
  if (!next?.phase || !next.sessionId || !Array.isArray(next.entries)) throw new Error('The room could not be read.');
  if (retiredSessions.has(next.sessionId)) return false;
  if (state?.sessionId === next.sessionId && next.revision < state.revision) return false;
  if (state && state.sessionId !== next.sessionId) { retiredSessions.add(state.sessionId); setControls(true); }
  const reveal = state && state.phase !== next.phase && next.phase.endsWith('_reveal');
  state = next; render();
  if (reveal) { setControls(false); dismissHints(); const stage = document.querySelector('.host-stage'); stage.tabIndex = -1; stage.focus({ preventScroll: true }); }
  return true;
}
async function refresh() {
  if (leaving) return;
  try { const next = await api('/api/host/state'); if (!next.config) next.config = await api('/api/config'); acceptState(next); clearError(); }
  catch (failure) { if (failure.status === 401) signIn(); else error(failure.message); }
}
const poller = createPoller(refresh);
async function control(action) {
  if (!action || busy || !state) return;
  busy = true; dismissHints(); clearError(); render();
  try {
    const result = await api('/api/host/control', { method: 'POST', body: { action, sessionId: state.sessionId } });
    if (result.state) acceptState(result.state); else await refresh();
    if (action === 'reset' || action === 'open_hometown') { setControls(true); setMore(false); }
    poller.refresh();
  } catch (failure) { if (failure.status === 401) signIn(); else { error(failure.message); setControls(true); } }
  finally { busy = false; render(); }
}
$('primary-control').addEventListener('click', () => control($('primary-control').dataset.action));
$('pause-control').addEventListener('click', () => control(state?.clock?.paused ? 'resume' : 'pause'));
$('more-toggle').addEventListener('click', () => setMore(!moreVisible));
$('hide-controls').addEventListener('click', () => { dismissHints(); setControls(false, true); });
$('show-controls').addEventListener('click', () => setControls(true, true));
$('list-control').addEventListener('click', () => { listVisible = !listVisible; updateList(); setMore(false); });
$('close-place-list').addEventListener('click', () => { listVisible = false; updateList(); });
$('reset-control').addEventListener('click', () => { setMore(false); $('reset-dialog').returnValue = ''; $('reset-dialog').showModal(); });
$('reset-dialog').addEventListener('close', () => { if ($('reset-dialog').returnValue === 'clear') control('reset'); });
const participantUrl = new URL('/join', window.location.href).href;
$('participant-link').href = participantUrl;
$('copy-link').addEventListener('click', async () => {
  dismissHints(); setMore(false);
  try { await navigator.clipboard.writeText(participantUrl); status('Participant link copied.'); }
  catch { status(participantUrl); }
});
async function fullscreen() {
  dismissHints(); setMore(false);
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else status('Use your browser’s full-screen command.');
  } catch { status('Use your browser’s full-screen command.'); }
}
$('fullscreen-control').addEventListener('click', fullscreen);
document.addEventListener('fullscreenchange', () => { setText('fullscreen-control', document.fullscreenElement ? 'Exit full screen' : 'Full screen'); presentation?.resize?.(); });
document.addEventListener('keydown', event => {
  if (isTyping(event.target) || event.target instanceof Element && event.target.closest('button,a,summary,[role="button"]') || $('reset-dialog').open || $('add-place-dialog').open || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space' && state?.phase.endsWith('_reveal')) { event.preventDefault(); control(state.clock?.paused ? 'resume' : 'pause'); }
  else if (event.key.toLowerCase() === 'h') { event.preventDefault(); dismissHints(); setControls(!controlsVisible); }
  else if (event.key.toLowerCase() === 'f') { event.preventDefault(); fullscreen(); }
  else if (event.key === 'Escape') { setMore(false); listVisible = false; updateList(); }
});
document.addEventListener('click', event => { if (moreVisible && !$('more-panel').contains(event.target) && !$('more-toggle').contains(event.target)) setMore(false); });

function assistedOpen() { return state?.sessionId === assisted.sessionId && state?.phase === assisted.round + '_open'; }
function assistedName() { return $('assisted-name').value.replace(/\s+/g, ' ').trim().slice(0, 40); }
function assistedPlace() { return normalizePlace(assisted.place, assisted.round, assisted.round === 'local' && $('assisted-home').checked ? 'home' : 'place', $('assisted-label').value); }
function syncAssisted() {
  if (!$('add-place-dialog').open) return;
  const locked = !assistedOpen() || assisted.submitting;
  $('assisted-closed').hidden = assistedOpen();
  setText('assisted-closed', 'This invitation has changed. Close this window and return to the current round.');
  for (const id of ['assisted-name', 'assisted-search', 'assisted-home', 'assisted-consent']) $(id).disabled = locked;
  $('assisted-label').disabled = locked || (assisted.round === 'local' && $('assisted-home').checked);
  $('assisted-search-button').disabled = locked || assisted.searching;
  $('submit-assisted').disabled = locked || !assisted.place;
  $('close-add-place').disabled = assisted.submitting;
  setText('submit-assisted', assisted.submitting ? 'Adding…' : 'Add');
}
function assistedReview() {
  if (!assisted.place) return;
  const home = assisted.round === 'local' && $('assisted-home').checked;
  if (home) $('assisted-label').value = 'A neighborhood';
  setText('assisted-details', `${assistedName() || 'Anonymous'}${home ? ' · Only a rounded area is shared.' : ' · This place appears on the shared map.'}`);
  $('assisted-review').hidden = false; syncAssisted();
}
function chooseAssisted(raw) {
  if (!assistedOpen() || assisted.submitting || !validPlace(raw)) return;
  assisted.place = { ...raw, label: String(raw.label || 'A chosen place').slice(0, 120), lat: Number(raw.lat), lng: Number(raw.lng) };
  assisted.publicLabel = assisted.place.label; $('assisted-label').value = assisted.publicLabel; $('assisted-consent').checked = false;
  assisted.sequence++; assisted.searching = false; $('assisted-results').replaceChildren(); setText('assisted-search-status', ''); setText('assisted-error', '');
  assistedReview(); $('assisted-review').scrollIntoView({ block: 'nearest' });
}
$('add-place-control').addEventListener('click', () => {
  if (!state?.phase.endsWith('_open')) return;
  assisted.round = state.round; assisted.sessionId = state.sessionId; assisted.place = null; assisted.publicLabel = ''; assisted.sequence++; assisted.searching = false;
  for (const id of ['assisted-name', 'assisted-search', 'assisted-label']) $(id).value = '';
  $('assisted-home').checked = false; $('assisted-consent').checked = false; $('assisted-review').hidden = true; $('assisted-results').replaceChildren();
  setText('assisted-search-status', ''); setText('assisted-error', '');
  const hometown = assisted.round === 'hometown'; $('assisted-home-option').hidden = hometown;
  $('assisted-search').placeholder = hometown ? 'Town, state or country' : 'Place name or neighborhood';
  setText('assisted-search-label', hometown ? 'Hometown' : 'Place');
  setMore(false); dismissHints(); $('add-place-dialog').showModal(); syncAssisted(); $('assisted-name').focus();
});
$('close-add-place').addEventListener('click', () => { if (!assisted.submitting) $('add-place-dialog').close(); });
$('add-place-dialog').addEventListener('cancel', event => { if (assisted.submitting) event.preventDefault(); });
$('add-place-dialog').addEventListener('close', () => { assisted.sequence++; assisted.searching = false; });
$('assisted-search-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!assistedOpen() || assisted.submitting) return;
  const query = $('assisted-search').value.trim();
  if (query.length < 2) { setText('assisted-search-status', 'Enter a place name.'); return; }
  const token = ++assisted.sequence; assisted.searching = true; syncAssisted(); $('assisted-results').replaceChildren(); setText('assisted-search-status', 'Searching…');
  try {
    const result = await api(`/api/search?${new URLSearchParams({ q: query, round: assisted.round })}`, { timeout: 14000 });
    if (token !== assisted.sequence || !assistedOpen() || !$('add-place-dialog').open) return;
    const results = liveResults(result);
    if (results === null) { setText('assisted-search-status', 'Search is unavailable right now. Try again shortly.'); return; }
    renderResults($('assisted-results'), results, chooseAssisted);
    setText('assisted-search-status', results.length ? 'Choose the place they mean.' : 'No matching places. Try a more specific name.');
  } catch { if (token === assisted.sequence) setText('assisted-search-status', 'Search is unavailable right now. Try again shortly.'); }
  finally { if (token === assisted.sequence) { assisted.searching = false; syncAssisted(); } }
});
$('assisted-name').addEventListener('input', () => { $('assisted-consent').checked = false; assistedReview(); });
$('assisted-label').addEventListener('input', () => { assisted.publicLabel = $('assisted-label').value; $('assisted-consent').checked = false; assistedReview(); });
$('assisted-home').addEventListener('change', () => {
  if ($('assisted-home').checked) assisted.publicLabel = $('assisted-label').value;
  else $('assisted-label').value = assisted.publicLabel || assisted.place?.label || '';
  $('assisted-consent').checked = false; assistedReview();
});
$('submit-assisted').addEventListener('click', async () => {
  if (assisted.submitting || !assistedOpen() || !validPlace(assisted.place)) return;
  if (!$('assisted-label').value.trim()) { setText('assisted-error', 'Give the place a short label.'); $('assisted-label').focus(); return; }
  if (!$('assisted-consent').checked) { setText('assisted-error', 'Confirm the place and name with them first.'); $('assisted-consent').focus(); return; }
  const payload = { sessionId: assisted.sessionId, round: assisted.round, displayName: assistedName(), place: assistedPlace() };
  assisted.submitting = true; syncAssisted(); setText('assisted-error', '');
  try {
    const result = await api('/api/host/contributions', { method: 'POST', body: payload });
    if (result.state) acceptState(result.state); else await refresh();
    if (state?.sessionId !== payload.sessionId) { setText('assisted-error', 'The room changed. Close this window and return to the current invitation.'); return; }
    $('add-place-dialog').close(); status('Place added.'); poller.refresh();
  } catch (failure) { if (failure.status === 401) signIn(); else { setText('assisted-error', failure.message); if (failure.status === 409) poller.refresh(); } }
  finally { assisted.submitting = false; syncAssisted(); render(); }
});
window.addEventListener('resize', () => presentation?.resize?.());
window.addEventListener('pagehide', () => poller.stop());
window.addEventListener('pageshow', event => { if (event.persisted) poller.start(); });
poller.start();
