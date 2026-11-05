import { HttpError } from './errors.mjs';
import { approximateHome, distanceKm, EXAMPLE_PLACES } from './places.mjs';

export const PHASES = Object.freeze([
  'local_open', 'local_reveal', 'local_rest',
  'hometown_open', 'hometown_reveal', 'hometown_rest', 'complete',
]);
export const MAX_ENTRIES = 400;

function cleanText(value, field, maximum, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new HttpError(400, field + ' must be text.', 'invalid_contribution');
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ((!optional && !text) || text.length > maximum) {
    throw new HttpError(400, field + ' must contain ' + (optional ? '0' : '1') + '–' + maximum + ' characters.', 'invalid_contribution');
  }
  return text;
}

export function normalizePlace(input, round, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Choose a place before sharing.', 'invalid_place');
  }
  const { lat, lng } = input;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -85 || lat > 85 || lng < -180 || lng > 180) {
    throw new HttpError(400, 'That place needs valid latitude and longitude.', 'invalid_place');
  }
  if (round === 'local' && distanceKm(config.center, { lat, lng }) > config.radiusKm) {
    throw new HttpError(400, 'Choose a local place within about 40 miles of the room.', 'outside_local_area');
  }
  const kind = input.kind ?? (round === 'hometown' ? 'town' : 'place');
  if (!['place', 'home', 'town'].includes(kind)) throw new HttpError(400, 'Choose a valid type of place.', 'invalid_place');
  // Residential labels and original coordinates are never retained in the room.
  if (kind === 'home') return approximateHome({ lat, lng });
  return {
    label: cleanText(input.label, 'Place label', 160),
    lat, lng,
    kind: round === 'hometown' ? 'town' : kind,
    approximate: false,
  };
}

export class Room {
  constructor(config, { now = Date.now } = {}) {
    this.config = structuredClone(config);
    this.now = now;
    this.revision = 0;
    this.reset();
  }

  reset() {
    this.sessionId = crypto.randomUUID();
    this.phase = 'local_open';
    this.round = 'local';
    this.entries = new Map();
    this.demoMode = false;
    this.clock = { startedAt: null, elapsedMs: 0, paused: true, durationMs: this.config.localDurationMs };
    this.revision += 1;
  }

  // Only application state is persisted here. Participant identifiers remain
  // internal and are never included in public or presenter response entries.
  snapshot() {
    return structuredClone({
      version: 2,
      sessionId: this.sessionId,
      revision: this.revision,
      phase: this.phase,
      round: this.round,
      demoMode: this.demoMode,
      clock: this.clock,
      entries: [...this.entries].map(([participantId, rounds]) => [participantId, [...rounds]]),
    });
  }

  restore(snapshot) {
    if (!snapshot || snapshot.version !== 2 || typeof snapshot.sessionId !== 'string' ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
        !PHASES.includes(snapshot.phase) || !['local', 'hometown'].includes(snapshot.round) ||
        !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ENTRIES ||
        !snapshot.clock || typeof snapshot.clock.paused !== 'boolean' ||
        !Number.isFinite(snapshot.clock.elapsedMs) || snapshot.clock.elapsedMs < 0 ||
        !Number.isFinite(snapshot.clock.durationMs) || snapshot.clock.durationMs <= 0 ||
        (snapshot.clock.startedAt !== null && !Number.isFinite(snapshot.clock.startedAt))) {
      throw new Error('The stored room format is not supported.');
    }
    const entries = new Map();
    for (const row of snapshot.entries) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' ||
          !Array.isArray(row[1]) || row[1].length > 2) throw new Error('The stored room could not be read.');
      const rounds = new Map();
      for (const pair of row[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || !['local', 'hometown'].includes(pair[0]) ||
            !pair[1] || pair[1].round !== pair[0] || typeof pair[1].id !== 'string' ||
            typeof pair[1].displayName !== 'string' || typeof pair[1].createdAt !== 'string' ||
            !pair[1].place || typeof pair[1].place.label !== 'string' ||
            !Number.isFinite(pair[1].place.lat) || !Number.isFinite(pair[1].place.lng)) {
          throw new Error('A stored contribution could not be read.');
        }
        rounds.set(pair[0], structuredClone(pair[1]));
      }
      entries.set(row[0], rounds);
    }
    this.sessionId = snapshot.sessionId;
    this.revision = snapshot.revision;
    this.phase = snapshot.phase;
    this.round = snapshot.round;
    this.demoMode = Boolean(snapshot.demoMode);
    this.clock = structuredClone(snapshot.clock);
    this.entries = entries;
  }

  elapsed() {
    return Math.min(this.clock.durationMs,
      this.clock.elapsedMs + (this.clock.paused || this.clock.startedAt === null ? 0 : Math.max(0, this.now() - this.clock.startedAt)));
  }

  syncClock() {
    if (this.phase.endsWith('_reveal') && this.elapsed() >= this.clock.durationMs) {
      this.clock = { ...this.clock, elapsedMs: this.clock.durationMs, startedAt: null, paused: true };
      this.phase = this.round + '_rest';
      this.revision += 1;
    }
  }

  allEntries() {
    return [...this.entries.values()].flatMap((rounds) => [...rounds.values()]);
  }

  counts() {
    const all = this.allEntries();
    return { local: all.filter((entry) => entry.round === 'local').length, hometown: all.filter((entry) => entry.round === 'hometown').length };
  }

  state(participantId, { host = false } = {}) {
    this.syncClock();
    const mine = this.entries.get(participantId);
    const state = {
      sessionId: this.sessionId,
      revision: this.revision,
      serverTime: this.now(),
      phase: this.phase,
      round: this.round,
      counts: this.counts(),
      clock: { ...this.clock },
      own: { local: mine?.get('local') ?? null, hometown: mine?.get('hometown') ?? null },
      config: this.config,
      demoMode: this.demoMode,
    };
    if (host) state.entries = this.allEntries().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return structuredClone(state);
  }

  assertOpen(round) {
    if (!['local', 'hometown'].includes(round)) throw new HttpError(400, 'Choose a valid round.', 'invalid_round');
    this.syncClock();
    if (this.phase !== round + '_open') {
      throw new HttpError(409, 'This round is no longer gathering places. Follow the shared view, or wait for the next invitation.', 'round_closed');
    }
  }

  contribute(participantId, payload) {
    if (!participantId) throw new HttpError(400, 'Open the participant page before sharing.', 'participant_required');
    this.assertOpen(payload.round);
    const displayName = cleanText(payload.displayName, 'Display name', 40, true);
    const place = normalizePlace(payload.place, payload.round, this.config);
    const rounds = this.entries.get(participantId) ?? new Map();
    const previous = rounds.get(payload.round);
    if (!previous && this.allEntries().length >= MAX_ENTRIES) {
      throw new HttpError(429, 'The room is full. Ask the presenter to begin a new room.', 'room_full');
    }
    const entry = {
      id: previous?.id ?? crypto.randomUUID(),
      round: payload.round,
      displayName,
      place,
      createdAt: previous?.createdAt ?? new Date(this.now()).toISOString(),
      isExample: false,
    };
    rounds.set(payload.round, entry);
    this.entries.set(participantId, rounds);
    this.revision += 1;
    return structuredClone(entry);
  }

  remove(participantId, round) {
    this.assertOpen(round);
    const rounds = this.entries.get(participantId);
    if (rounds?.delete(round)) {
      if (!rounds.size) this.entries.delete(participantId);
      this.revision += 1;
    }
  }

  control(action) {
    this.syncClock();
    if (action === 'reset') {
      this.reset();
      return;
    }
    if (action === 'demo') {
      if (this.phase !== 'local_open' || this.entries.size) {
        throw new HttpError(409, 'Start an empty room before loading the example places.', 'room_not_empty');
      }
      this.seedExamples();
      return;
    }
    if (action === 'start_local' || action === 'start_hometown') {
      const round = action === 'start_local' ? 'local' : 'hometown';
      if (this.phase === round + '_reveal') return;
      if (this.phase !== round + '_open') throw new HttpError(409, 'Open that contribution round before beginning its shared view.', 'invalid_transition');
      if (this.counts()[round] === 0) throw new HttpError(409, 'Offer a place before beginning the shared view.', 'no_contributions');
      this.round = round;
      this.phase = round + '_reveal';
      this.clock = {
        startedAt: this.now(), elapsedMs: 0, paused: false,
        durationMs: round === 'local' ? this.config.localDurationMs : this.config.hometownDurationMs,
      };
    } else if (action === 'pause') {
      if (!this.phase.endsWith('_reveal')) throw new HttpError(409, 'The shared view is already resting.', 'invalid_transition');
      if (this.clock.paused) return;
      this.clock = { ...this.clock, elapsedMs: this.elapsed(), paused: true, startedAt: null };
    } else if (action === 'resume') {
      if (!this.phase.endsWith('_reveal')) throw new HttpError(409, 'Begin a shared view before resuming it.', 'invalid_transition');
      if (!this.clock.paused) return;
      this.clock = { ...this.clock, paused: false, startedAt: this.now() };
    } else if (action === 'open_hometown') {
      if (this.phase === 'hometown_open') return;
      if (!this.phase.startsWith('local_')) throw new HttpError(409, 'This room has already moved into the second round.', 'invalid_transition');
      this.round = 'hometown';
      this.phase = 'hometown_open';
      this.clock = { startedAt: null, elapsedMs: 0, paused: true, durationMs: this.config.hometownDurationMs };
    } else if (action === 'finish') {
      if (this.phase === 'complete') return;
      this.clock = { ...this.clock, elapsedMs: this.elapsed(), paused: true, startedAt: null };
      this.phase = 'complete';
    } else {
      throw new HttpError(400, 'Unknown presenter action.', 'invalid_action');
    }
    this.revision += 1;
  }

  seedExamples() {
    const local = EXAMPLE_PLACES.filter((place) => place.kind === 'place' && distanceKm(this.config.center, place) <= this.config.radiusKm).slice(0, 5);
    const hometowns = ['Richmond', 'Amsterdam', 'Tokyo', 'Accra', 'Buenos Aires'].map((name) => EXAMPLE_PLACES.find((place) => place.label === name));
    const names = ['Example · Rowan', 'Example · Ari', 'Example · Jules', 'Example · Sam', 'Example · Lee'];
    for (let index = 0; index < local.length; index += 1) {
      const rounds = new Map();
      for (const [round, source] of [['local', local[index]], ['hometown', hometowns[index]]]) {
        if (!source) continue;
        rounds.set(round, {
          id: crypto.randomUUID(), round, displayName: names[index],
          place: normalizePlace(source, round, this.config),
          createdAt: new Date(this.now() + index).toISOString(), isExample: true,
        });
      }
      this.entries.set('example-' + index, rounds);
    }
    this.demoMode = true;
    this.revision += 1;
  }
}
