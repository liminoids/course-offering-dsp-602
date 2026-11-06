import { $, api, createPoller, stateGate, text, isTyping, roundOf, isOpen, cleanName, validPlace, normalizePlace, placeDescription, liveResults, renderResults, mapStatus, elapsedTime, motion } from './client.js';

const gate = stateGate(), rows = new Map();
let state = null, config = null, presentation = null, revealProgress = null, mapLoading = false, mapFailed = false;
let busy = false, leaving = false, controlsVisible = true, moreVisible = false, selectedMemberId = null, focusedEntryId = null;
let serverOffset = 0, uiFrame = 0, lastStatusUpdate = 0, statusTimer = null, seek = null, seekSerial = 0;
let ambientHeld = false;
const assisted = { round: null, sessionId: null, memberId: null, place: null, publicLabel: '', sequence: 0, searching: false, submitting: false };
const currentRound = () => roundOf(state);
const count = () => Number(state?.counts?.[currentRound()]) || 0;
const running = () => Boolean(state?.phase?.endsWith('_reveal') && !state.clock?.paused);
const canSeek = () => Boolean(state?.phase?.endsWith('_reveal') || state?.phase?.endsWith('_rest') || state?.phase === 'complete');
const atGlobe = () => state?.phase === 'hometown_rest' || state?.phase === 'complete';
function signIn() { if (!leaving) { leaving = true; poller.stop(); location.assign('/_gate/login?next=%2Fv2%2F'); } }
function report(message) { text('connection-message', message); $('connection-error').hidden = !message; }
function status(message) { clearTimeout(statusTimer); text('control-message', message); statusTimer = setTimeout(() => text('control-message', ''), 6500); }
function setMore(visible) { moreVisible = visible; $('more-panel').hidden = !visible; $('more-control').setAttribute('aria-expanded', String(visible)); }
function setControls(visible, focus = false) {
  controlsVisible = visible; $('transport').hidden = !visible; $('show-controls').hidden = visible;
  document.querySelector('.map-modes').hidden = !visible;
  if (!visible) setMore(false);
  if (focus) (visible ? $('play-control') : $('show-controls')).focus();
}
function setRail(visible, focus = false) {
  $('member-rail').hidden = !visible; $('room').classList.toggle('rail-hidden', !visible);
  $('show-rail').hidden = visible; $('show-rail').setAttribute('aria-expanded', String(visible));
  requestAnimationFrame(() => presentation?.resize?.());
  if (focus) (visible ? $('hide-rail') : $('show-rail')).focus();
}
function entryFor(member, round = currentRound()) {
  return state?.entries?.find(entry => entry.id === member?.[round + 'EntryId']) || state?.entries?.find(entry => entry.memberId === member?.id && entry.round === round) || null;
}
function effectiveState() {
  if (!seek || !state) return state;
  return { ...state, phase: currentRound() + '_reveal', clock: { ...state.clock, elapsedMs: seek.fraction * state.clock.durationMs, startedAt: null, paused: true } };
}
function arrival(entry) {
  if (!entry) return 'arrived';
  if (!revealProgress) return state?.phase?.endsWith('_rest') || state?.phase === 'complete' ? 'shared' : 'place held';
  const progress = revealProgress(effectiveState(), entry, config, Date.now() + serverOffset);
  return progress >= .999 ? 'shared' : progress > .001 ? 'arriving' : 'place held';
}
function updateRows() {
  if (!state) return;
  const members = state.members || [], present = new Set(members.map(member => member.id));
  for (const [id, row] of rows) { if (!present.has(id)) { row.item.remove(); rows.delete(id); } }
  const empty = $('member-list').querySelector('.empty-room');
  if (members.length && empty) empty.remove();
  if (!members.length && !empty) { const li = document.createElement('li'); li.className = 'empty-room'; li.textContent = 'the room is open.'; $('member-list').append(li); }
  for (const member of members) {
    let row = rows.get(member.id);
    if (!row) {
      const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.className = 'member-button';
      const name = document.createElement('span'), place = document.createElement('span'), stateLabel = document.createElement('span'), context = document.createElement('span');
      name.className = 'member-name'; place.className = 'member-place'; stateLabel.className = 'member-state'; context.className = 'member-context';
      button.append(name, place, stateLabel, context); item.append(button); $('member-list').append(item);
      button.addEventListener('click', () => selectMember(member.id));
      row = { item, button, name, place, stateLabel, context }; rows.set(member.id, row);
    }
    const entry = entryFor(member), local = currentRound() === 'hometown' ? entryFor(member, 'local') : null;
    const label = member.displayName || 'anonymous';
    row.name.textContent = label; row.place.textContent = entry?.place?.label || (isOpen(state) ? 'choosing a place' : 'no place shared this round');
    row.stateLabel.textContent = arrival(entry); row.context.textContent = local ? 'nearby · ' + local.place.label : ''; row.context.hidden = !local;
    row.button.setAttribute('aria-pressed', String(selectedMemberId === member.id));
    row.button.setAttribute('aria-label', label + ' · ' + row.place.textContent + ' · ' + row.stateLabel.textContent);
  }
  const people = members.length, places = count();
  text('member-summary', `${people} ${people === 1 ? 'person' : 'people'} · ${places} ${places === 1 ? 'place' : 'places'}`);
}
async function selectMember(id) {
  if (busy || seek || !state?.members?.some(member => member.id === id)) return;
  const sessionId = state.sessionId;
  if (running()) {
    busy = true; renderControls();
    try { await requestControl('pause', {}, sessionId); }
    catch (error) { if (error.status === 401) signIn(); else { report(error.message); poller.refresh(); } return; }
    finally { busy = false; renderControls(); }
  }
  if (state?.sessionId !== sessionId || !state.members.some(member => member.id === id)) return;
  selectedMemberId = id; focusedEntryId = null; renderInspector(); updateRows();
  if (matchMedia('(max-width:650px)').matches) setRail(false);
}
function clearFocus() { selectedMemberId = null; focusedEntryId = null; presentation?.focusEntry?.(null); $('place-inspector').hidden = true; updateRows(); }
function renderInspector() {
  if (!selectedMemberId || !state) return;
  const member = state.members.find(candidate => candidate.id === selectedMemberId);
  if (!member) { clearFocus(); return; }
  const entry = entryFor(member), other = entryFor(member, currentRound() === 'local' ? 'hometown' : 'local');
  text('inspector-person', member.displayName || 'anonymous');
  text('inspector-place', entry?.place?.label || 'a place is still to come.');
  text('inspector-locality', entry?.place?.detail || (entry ? '' : isOpen(state) ? 'this invitation is open.' : 'no place was shared in this round.'));
  text('inspector-precision', entry ? placeDescription(entry.place) : 'arrived in the room');
  text('inspector-other', other ? (other.round === 'local' ? 'nearby · ' : 'hometown · ') + other.place.label : ''); $('inspector-other').hidden = !other;
  $('place-inspector').hidden = false;
  const signature = entry ? JSON.stringify([entry.id, entry.place.lat, entry.place.lng, entry.place.label, entry.displayName, entry.place.approximate]) : 'waiting';
  if (focusedEntryId !== signature) { focusedEntryId = signature; presentation?.focusEntry?.(entry); }
}
function receiveMapStatus(message, detail) {
  const result = mapStatus(message, detail);
  const copy = result.available && result.state === 'ready' ? result.message || '' : result.message || '';
  text('map-feedback', copy); $('map-feedback').hidden = !copy;
  if (result.modes) for (const button of document.querySelectorAll('[data-mode]')) {
    button.disabled = !result.modes[button.dataset.mode];
    button.setAttribute('aria-label', button.dataset.mode + ' map' + (button.disabled ? ', unavailable' : ''));
  }
  if (result.mode) for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === result.mode));
}
async function ensureMap() {
  if (presentation || mapLoading || mapFailed || !config) return;
  mapLoading = true;
  try {
    const maps = await import('./map.js'); revealProgress = maps.entryRevealProgress;
    presentation = await maps.createPresentationMap($('presentation-map'), { config, onStatus: receiveMapStatus });
    presentation?.update?.(state); presentation?.setMotionPaused?.(ambientHeld); focusedEntryId = null; renderInspector(); updateRows();
  } catch (error) {
    mapFailed = true; text('map-feedback', 'the map is unavailable. the room’s places are still listed.'); $('map-feedback').hidden = false; setRail(true);
  } finally { mapLoading = false; }
}
function renderControls() {
  if (!state) return;
  const round = currentRound(), phase = state.phase, isRunning = running(), open = isOpen(state);
  text('round-label', phase === 'complete' ? 'here, together' : round === 'hometown' ? 'hometowns' : 'nearby');
  const caption = open ? 'the invitation is open' : phase === 'complete' ? 'the room’s places, held together' : selectedMemberId ? 'one place in the room' : isRunning ? 'the shared view is unfolding' : 'the shared view is held';
  text('room-caption', (state.demoMode ? 'example room · ' : '') + caption);
  const completed = phase.endsWith('_rest') || phase === 'complete';
  text('play-label', atGlobe() ? motion.matches ? 'globe held' : ambientHeld ? 'continue globe' : 'hold globe' : open ? 'begin' : completed ? 'replay' : isRunning ? 'hold' : 'continue');
  $('play-control').dataset.running = String((isRunning || atGlobe() && !ambientHeld && !motion.matches) && !seek);
  $('play-control').disabled = busy || Boolean(seek) || open && count() === 0 || atGlobe() && motion.matches;
  $('shared-progress').disabled = !canSeek() || busy;
  text('progress-to', round === 'hometown' ? 'the world' : 'nearby');
  text('round-control', round === 'local' ? 'invite hometowns' : phase === 'complete' ? 'held together' : 'finish');
  $('round-control').disabled = busy || Boolean(seek) || !(phase.startsWith('local_') || phase === 'hometown_rest');
  $('round-control').title = phase.startsWith('local_') || phase === 'hometown_rest' ? '' : 'Available when this shared view reaches its end.';
  $('reset-control').disabled = busy || Boolean(seek); $('confirm-reset').disabled = busy;
  $('replay-control').hidden = !completed; $('replay-control').disabled = busy || Boolean(seek);
  $('demo-control').hidden = Boolean(state.members.length || state.entries.length || state.demoMode); $('demo-control').disabled = busy;
  $('add-person').disabled = busy || !open;
  renderProgress(); syncAssisted();
}
function renderProgress() {
  if (!state) return;
  const fraction = seek ? seek.fraction : Math.min(1, elapsedTime(state, Date.now() + serverOffset) / (state.clock?.durationMs || 1));
  if (!seek) $('shared-progress').value = Math.round(fraction * 1000);
  $('shared-progress').style.setProperty('--progress', (fraction * 100) + '%');
  $('shared-progress').setAttribute('aria-valuetext', `${Math.round(fraction * 100)} percent · ${seek || !running() ? 'held' : 'unfolding'}`);
  text('progress-state', seek ? 'held' : running() ? 'unfolding' : isOpen(state) ? 'ready' : 'held');
}
function startUiClock() {
  if (uiFrame || document.hidden) return;
  function frame(now) {
    uiFrame = 0; if (document.hidden) return;
    renderProgress(); if (now - lastStatusUpdate > 240) { updateRows(); lastStatusUpdate = now; }
    if (running() || seek) uiFrame = requestAnimationFrame(frame);
  }
  uiFrame = requestAnimationFrame(frame);
}
function acceptState(next) {
  if (!Array.isArray(next?.entries) || !Array.isArray(next?.members)) throw new Error('The room could not be read. Please try again.');
  const previous = state;
  if (!gate.accept(next)) return false;
  state = next; config = next.config || config; serverOffset = Number(next.serverTime) - Date.now() || 0;
  if (previous && (previous.sessionId !== next.sessionId || roundOf(previous) !== currentRound())) {
    seekSerial++; seek = null; presentation?.setProgressPreview?.(null); focusedEntryId = null;
    if (previous.sessionId !== next.sessionId) { clearFocus(); ambientHeld = false; presentation?.setMotionPaused?.(false); setControls(true); }
  }
  if (selectedMemberId && !state.members.some(member => member.id === selectedMemberId)) clearFocus();
  renderControls(); updateRows(); renderInspector(); ensureMap();
  presentation?.update?.(state); startUiClock(); return true;
}
async function refresh() {
  if (leaving) return;
  try { const next = await api('/host/state'); if (!next.config && !config) next.config = await api('/config'); acceptState(next); report(''); }
  catch (error) { if (error.status === 401) signIn(); else report(error.message); }
}
const poller = createPoller(refresh, 1800);
async function requestControl(action, extra = {}, sessionId = state?.sessionId) {
  const result = await api('/host/control', { method: 'POST', body: { action, sessionId, ...extra } });
  if (result.state) acceptState(result.state); else await refresh();
  return result;
}
async function control(action, extra = {}) {
  if (busy || seek || !state) return;
  busy = true; report(''); renderControls();
  try {
    await requestControl(action, extra);
    if (action === 'reset' || action === 'open_hometown') { setMore(false); setControls(true); }
    poller.refresh();
  } catch (error) { if (error.status === 401) signIn(); else { report(error.message); if (error.status === 409) poller.refresh(); } }
  finally { busy = false; renderControls(); }
}
async function play(replay = false) {
  if (!state || busy || seek) return;
  if (atGlobe() && !replay) { if (motion.matches) return; ambientHeld = !ambientHeld; presentation?.setMotionPaused?.(ambientHeld); renderControls(); return; }
  if (isOpen(state)) return control('start_' + currentRound());
  if (state.phase.endsWith('_rest') || state.phase === 'complete') {
    busy = true; renderControls(); const sessionId = state.sessionId;
    try { await requestControl('seek', { elapsedMs: 0 }, sessionId); if (state.sessionId === sessionId) await requestControl('resume', {}, sessionId); poller.refresh(); }
    catch (error) { if (error.status === 401) signIn(); else report(error.message); }
    finally { busy = false; renderControls(); }
    return;
  }
  return control(running() ? 'pause' : 'resume');
}
function beginSeek(dragging = false) {
  if (!canSeek() || busy) return null;
  if (seek) { seek.dragging ||= dragging; return seek; }
  clearFocus();
  const ctx = { serial: ++seekSerial, sessionId: state.sessionId, round: currentRound(), fraction: Number($('shared-progress').value) / 1000, duration: state.clock.durationMs, dragging, version: 0, requested: null, committing: false, failed: false, pause: null };
  seek = ctx; presentation?.setProgressPreview?.(ctx.fraction); renderControls();
  ctx.pause = running() ? requestControl('pause', {}, ctx.sessionId).catch(error => {
    if (error.status === 409) return refresh();
    ctx.failed = true; if (error.status === 401) signIn(); else report(error.message);
  }) : Promise.resolve();
  startUiClock(); return ctx;
}
function previewSeek() {
  const ctx = beginSeek(); if (!ctx) return;
  ctx.fraction = Math.max(0, Math.min(1, Number($('shared-progress').value) / 1000)); ctx.version++;
  presentation?.setProgressPreview?.(ctx.fraction); renderProgress(); updateRows();
}
async function commitSeek() {
  const ctx = seek; if (!ctx) return;
  ctx.requested = { fraction: ctx.fraction, version: ctx.version };
  if (ctx.committing) return;
  ctx.committing = true;
  try {
    await ctx.pause;
    while (seek === ctx && ctx.requested && !ctx.failed) {
      if (state?.sessionId !== ctx.sessionId || currentRound() !== ctx.round) return;
      const request = ctx.requested; ctx.requested = null;
      await requestControl('seek', { elapsedMs: Math.round(request.fraction * ctx.duration) }, ctx.sessionId);
      if (seek !== ctx) return;
      if (!ctx.requested && !ctx.dragging && request.version === ctx.version) { seek = null; presentation?.setProgressPreview?.(null); status('held here. continue when you’re ready.'); }
    }
  } catch (error) {
    if (error.status === 401) signIn(); else report(error.message);
    ctx.failed = true; poller.refresh();
  } finally {
    ctx.committing = false;
    if (ctx.failed && seek === ctx) { seek = null; presentation?.setProgressPreview?.(null); }
    renderControls(); updateRows();
  }
}
$('play-control').addEventListener('click', () => play());
$('replay-control').addEventListener('click', () => { setMore(false); play(true); });
$('round-control').addEventListener('click', () => { if (state?.phase?.startsWith('local_')) control('open_hometown'); else if (state?.phase === 'hometown_rest') control('finish'); });
$('demo-control').addEventListener('click', () => { if (state && !state.members.length && !state.entries.length) { setMore(false); control('demo'); } });
$('shared-progress').addEventListener('pointerdown', () => beginSeek(true));
$('shared-progress').addEventListener('input', previewSeek);
$('shared-progress').addEventListener('change', () => { if (seek) { seek.dragging = false; commitSeek(); } });
$('shared-progress').addEventListener('pointerup', () => { if (seek) { seek.dragging = false; commitSeek(); } });
$('shared-progress').addEventListener('pointercancel', () => { if (seek) { seek.dragging = false; commitSeek(); } });
$('return-room').addEventListener('click', () => { clearFocus(); renderControls(); });
$('hide-rail').addEventListener('click', () => setRail(false, true));
$('show-rail').addEventListener('click', () => setRail(true, true));
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => { for (const item of document.querySelectorAll('[data-mode]')) item.setAttribute('aria-pressed', String(item === button)); presentation?.setMode?.(button.dataset.mode); });
$('more-control').addEventListener('click', () => setMore(!moreVisible));
$('hide-controls').addEventListener('click', () => setControls(false, true));
$('show-controls').addEventListener('click', () => setControls(true, true));
$('reset-control').addEventListener('click', () => { setMore(false); $('reset-dialog').showModal(); });
$('cancel-reset').addEventListener('click', () => { if (!busy) $('reset-dialog').close(); });
$('confirm-reset').addEventListener('click', async () => { if (!busy && !seek) { await control('reset'); $('reset-dialog').close(); } });
$('reset-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
const participantUrl = new URL('/v2/join', location.href).href; $('join-link').href = participantUrl;
$('copy-link').addEventListener('click', async () => { setMore(false); try { await navigator.clipboard.writeText(participantUrl); status('participant link copied.'); } catch { status(participantUrl); } });
async function fullscreen() {
  setMore(false);
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else status('use your browser’s full-screen command.'); }
  catch { status('use your browser’s full-screen command.'); }
}
$('fullscreen-control').addEventListener('click', fullscreen);
document.addEventListener('fullscreenchange', () => { text('fullscreen-control', document.fullscreenElement ? 'leave full screen' : 'full screen'); presentation?.resize?.(); });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || $('reset-dialog').open || $('assisted-dialog').open) return;
  if (event.code === 'Space' && !(event.target instanceof Element && event.target.closest('button,a,[role="button"]'))) { event.preventDefault(); play(); }
  else if (event.key.toLowerCase() === 'h') { event.preventDefault(); setControls(!controlsVisible); }
  else if (event.key === 'Escape') { setMore(false); clearFocus(); }
});
document.addEventListener('click', event => { if (moreVisible && !$('more-panel').contains(event.target) && !$('more-control').contains(event.target)) setMore(false); });

const assistedOpen = () => state?.sessionId === assisted.sessionId && state?.phase === assisted.round + '_open';
const assistedPrivate = () => assisted.round === 'local' && (assisted.place?.kind === 'home' || assisted.place?.precision === 'address');
const assistedPlace = () => normalizePlace(assisted.place, assisted.round, assisted.round === 'local' && $('assisted-home').checked, $('assisted-label').value, config?.center?.lat);
function syncAssisted() {
  if (!$('assisted-dialog').open) return;
  const locked = !assistedOpen() || assisted.submitting;
  $('assisted-closed').hidden = assistedOpen(); text('assisted-closed', 'the invitation changed. close this window and return to the room.');
  for (const id of ['assisted-name', 'assisted-query', 'assisted-home', 'assisted-consent']) $(id).disabled = locked;
  $('assisted-home').disabled = locked || assistedPrivate();
  $('assisted-label').disabled = locked || Boolean(assisted.place?.selectionToken) || assisted.round === 'local' && $('assisted-home').checked;
  $('assisted-search-button').disabled = locked || assisted.searching;
  $('submit-assisted').disabled = locked || !assisted.place; $('close-assisted').disabled = assisted.submitting;
  text('submit-assisted', assisted.submitting ? 'sharing…' : 'share this place');
}
function assistedReview() {
  if (!assisted.place) return;
  if (assisted.round === 'local' && $('assisted-home').checked) $('assisted-label').value = 'A neighborhood';
  text('assisted-detail', assistedPrivate() ? 'addresses are shared as an approximate area. the original address is not shared.' : placeDescription(assistedPlace())); $('assisted-review').hidden = false; syncAssisted();
}
function chooseAssisted(raw) {
  if (!assistedOpen() || assisted.submitting || !validPlace(raw)) return;
  assisted.place = { ...raw }; assisted.publicLabel = raw.label || 'A chosen place'; $('assisted-label').value = assisted.publicLabel;
  $('assisted-home').checked = assisted.round === 'local' && (raw.kind === 'home' || raw.precision === 'address');
  $('assisted-consent').checked = false; assisted.sequence++; assisted.searching = false;
  $('assisted-results').replaceChildren(); text('assisted-search-status', ''); text('assisted-error', ''); assistedReview(); $('assisted-label').focus();
}
$('add-person').addEventListener('click', () => {
  if (!state || !isOpen(state)) return;
  const member = state.members.find(item => item.id === selectedMemberId);
  assisted.round = currentRound(); assisted.sessionId = state.sessionId; assisted.memberId = member?.id || null;
  assisted.place = null; assisted.publicLabel = ''; assisted.sequence++; assisted.searching = false;
  $('assisted-name').value = member?.displayName || ''; $('assisted-query').value = ''; $('assisted-label').value = '';
  $('assisted-home').checked = false; $('assisted-consent').checked = false; $('assisted-review').hidden = true; $('assisted-results').replaceChildren();
  $('assisted-home-option').hidden = assisted.round === 'hometown'; $('assisted-query').placeholder = assisted.round === 'hometown' ? 'town, state or country' : 'place name or neighborhood';
  text('assisted-title', member ? 'a place for ' + (member.displayName || 'this person') : 'a place for someone');
  text('assisted-search-label', assisted.round === 'hometown' ? 'their hometown' : 'a nearby place'); text('assisted-search-status', ''); text('assisted-error', '');
  setMore(false); $('assisted-dialog').showModal(); syncAssisted(); (member ? $('assisted-query') : $('assisted-name')).focus();
});
$('close-assisted').addEventListener('click', () => { if (!assisted.submitting) $('assisted-dialog').close(); });
$('assisted-dialog').addEventListener('cancel', event => { if (assisted.submitting) event.preventDefault(); });
$('assisted-dialog').addEventListener('close', () => { assisted.sequence++; assisted.searching = false; });
async function assistedSearch() {
  if (!assistedOpen() || assisted.submitting) return;
  const query = $('assisted-query').value.trim(); if (query.length < 2) { text('assisted-search-status', 'enter a place name.'); return; }
  const sequence = ++assisted.sequence; assisted.searching = true; syncAssisted(); $('assisted-results').replaceChildren(); text('assisted-search-status', 'looking…');
  try {
    const result = await api('/search?' + new URLSearchParams({ q: query, round: assisted.round }), { timeout: 14000 });
    if (sequence !== assisted.sequence || !assistedOpen() || !$('assisted-dialog').open) return;
    const results = liveResults(result);
    if (results === null) { text('assisted-search-status', 'search is unavailable right now. try again, or ask them to choose on the participant map.'); return; }
    renderResults($('assisted-results'), results, chooseAssisted); text('assisted-search-status', results.length ? 'choose the place they mean.' : 'no matching places. try a more specific name.');
  } catch (error) { if (sequence === assisted.sequence) text('assisted-search-status', error.message); }
  finally { if (sequence === assisted.sequence) { assisted.searching = false; syncAssisted(); } }
}
$('assisted-search-button').addEventListener('click', assistedSearch);
$('assisted-query').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); assistedSearch(); } });
$('assisted-name').addEventListener('input', () => { $('assisted-consent').checked = false; });
$('assisted-label').addEventListener('input', () => { assisted.publicLabel = $('assisted-label').value; $('assisted-consent').checked = false; assistedReview(); });
$('assisted-home').addEventListener('change', () => { if ($('assisted-home').checked) assisted.publicLabel = $('assisted-label').value; else $('assisted-label').value = assisted.publicLabel || assisted.place?.label || ''; $('assisted-consent').checked = false; assistedReview(); });
$('submit-assisted').addEventListener('click', async () => {
  if (!assistedOpen() || assisted.submitting || !validPlace(assisted.place)) return;
  if (!$('assisted-label').value.trim()) { text('assisted-error', 'give the place a short label.'); $('assisted-label').focus(); return; }
  if (!$('assisted-consent').checked) { text('assisted-error', 'confirm the place and name with them first.'); $('assisted-consent').focus(); return; }
  const payload = { sessionId: assisted.sessionId, round: assisted.round, displayName: cleanName($('assisted-name').value), place: assistedPlace() };
  if (assisted.memberId) payload.memberId = assisted.memberId;
  assisted.submitting = true; syncAssisted(); text('assisted-error', '');
  try {
    const result = await api('/host/contributions', { method: 'POST', body: payload });
    if (result.state) acceptState(result.state); else await refresh();
    if (state.sessionId === payload.sessionId) { $('assisted-dialog').close(); status('their place is held.'); }
    poller.refresh();
  } catch (error) { if (error.status === 401) signIn(); else { text('assisted-error', error.message); if (error.status === 409) poller.refresh(); } }
  finally { assisted.submitting = false; syncAssisted(); renderControls(); }
});
$('retry-connection').addEventListener('click', () => { mapFailed = false; poller.refresh(); ensureMap(); });
window.addEventListener('resize', () => presentation?.resize?.());
motion.addEventListener?.('change', renderControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(uiFrame); uiFrame = 0; } else startUiClock(); });
window.addEventListener('pagehide', () => { poller.stop(); cancelAnimationFrame(uiFrame); uiFrame = 0; });
window.addEventListener('pageshow', event => { if (event.persisted) { poller.start(); startUiClock(); } });
if (matchMedia('(max-width:650px)').matches) setRail(false);
poller.start();
