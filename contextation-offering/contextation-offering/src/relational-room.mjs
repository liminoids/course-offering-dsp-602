import { Room, MAX_ENTRIES, normalizePlace } from './room.mjs';
import { distanceKm, EXAMPLE_PLACES } from './places.mjs';
import { HttpError } from './errors.mjs';

const text = (value, maximum) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';

// This model is used only by /api/v2, in its own Durable Object instance.
// Public member IDs connect the two invitations; participant cookies stay internal.
export class RelationalRoom extends Room {
  reset() {
    super.reset();
    this.members = new Map();
    this.localProgressAtHandoff = 0;
  }

  snapshot() {
    return { ...super.snapshot(), relationalVersion: 1, members: structuredClone([...this.members]), localProgressAtHandoff: this.localProgressAtHandoff };
  }

  restore(snapshot) {
    if (snapshot?.relationalVersion !== 1 || !Array.isArray(snapshot.members) || snapshot.members.length > MAX_ENTRIES) {
      throw new Error('The stored v2 room format is not supported.');
    }
    const members = new Map();
    const ids = new Set();
    for (const row of snapshot.members) {
      const member = row?.[1];
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !member ||
          typeof member.id !== 'string' || ids.has(member.id) || typeof member.displayName !== 'string' ||
          member.displayName.length > 40 || typeof member.joinedAt !== 'string') {
        throw new Error('A stored member could not be read.');
      }
      ids.add(member.id);
      members.set(row[0], structuredClone(member));
    }
    super.restore(snapshot);
    this.members = members;
    this.localProgressAtHandoff = Number.isFinite(snapshot.localProgressAtHandoff) ? Math.max(0, Math.min(1, snapshot.localProgressAtHandoff)) : 0;
    for (const [participantId, rounds] of this.entries) {
      if (!members.has(participantId) || [...rounds.values()].some(entry => entry.memberId !== members.get(participantId).id)) {
        throw new Error('A stored place has no matching member.');
      }
    }
  }

  join(participantId, payload = {}) {
    if (!participantId) throw new HttpError(400, 'Open the participant page before joining.', 'participant_required');
    if (this.phase === 'complete') throw new HttpError(409, 'The offering has come to rest.', 'room_complete');
    if (payload.displayName !== undefined && (typeof payload.displayName !== 'string' || payload.displayName.length > 40)) {
      throw new HttpError(400, 'Use a name of up to 40 characters, or stay anonymous.', 'invalid_name');
    }
    let member = this.members.get(participantId);
    const displayName = payload.displayName === undefined ? member?.displayName ?? '' : text(payload.displayName, 40);
    if (!member) {
      if (this.members.size >= MAX_ENTRIES) throw new HttpError(429, 'The room is full. Ask the presenter for help.', 'room_full');
      member = { id: crypto.randomUUID(), displayName, joinedAt: new Date(this.now()).toISOString() };
      this.members.set(participantId, member);
      this.revision += 1;
    } else if (member.displayName !== displayName) {
      member.displayName = displayName;
      for (const entry of this.entries.get(participantId)?.values() ?? []) entry.displayName = displayName;
      this.revision += 1;
    }
    return structuredClone(member);
  }

  publicMember(participantId) {
    const member = this.members.get(participantId);
    if (!member) return null;
    const entries = this.entries.get(participantId);
    return { ...member, localEntryId: entries?.get('local')?.id ?? null, hometownEntryId: entries?.get('hometown')?.id ?? null };
  }

  state(participantId, options = {}) {
    const state = super.state(participantId, options);
    state.member = this.publicMember(participantId);
    state.counts.members = this.members.size;
    state.localProgressAtHandoff = this.localProgressAtHandoff;
    if (options.host) state.members = [...this.members.keys()].map(id => this.publicMember(id)).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
    return structuredClone(state);
  }

  contribute(participantId, payload) {
    // Validate the place and invitation before creating a member.
    this.assertOpen(payload.round);
    normalizePlace(payload.place, payload.round, this.config);
    const previousPlace = this.entries.get(participantId)?.get(payload.round)?.place;
    const member = this.join(participantId, payload);
    const entry = super.contribute(participantId, { ...payload, displayName: member.displayName });
    entry.memberId = member.id;
    let input = payload.place;
    // Re-reviewing an unchanged, previously verified place must not erase its
    // provenance merely because short-lived search tokens are not persisted.
    if (previousPlace?.source === 'photon' && input.source === 'map' &&
        input.label === previousPlace.label && input.lat === previousPlace.lat && input.lng === previousPlace.lng &&
        input.kind === previousPlace.kind) input = { ...previousPlace };
    if (entry.place.kind === 'home') {
      // A local 500 m grid. Never keep the original point, address, provider ID,
      // or a signed search selection for a residential contribution.
      const metresPerDegree = Math.PI * 6371008.8 / 180;
      const xScale = metresPerDegree * Math.cos(this.config.center.lat * Math.PI / 180);
      const cell = value => (Math.floor(value / 500) + .5) * 500;
      entry.place = {
        label: 'a neighborhood', kind: 'home', approximate: true,
        lat: Number((cell(input.lat * metresPerDegree) / metresPerDegree).toFixed(6)),
        lng: Number((cell(input.lng * xScale) / xScale).toFixed(6)),
        detail: 'an approximate neighborhood area', source: 'participant', precision: 'approximate',
      };
    } else {
      entry.place.detail = text(input.detail, 240);
      entry.place.source = ['photon', 'example-catalog'].includes(input.source) ? input.source : 'map';
      entry.place.precision = payload.round === 'hometown' ? 'town' : input.precision === 'address' ? 'address' : 'point';
      if (input.source === 'photon' && /^[NWR][0-9]{1,20}$/.test(input.osmId ?? '')) entry.place.osmId = input.osmId;
      if (typeof input.category === 'string') entry.place.category = text(input.category, 60);
      entry.place.distanceKm = Math.round(distanceKm(this.config.center, entry.place) * 100) / 100;
    }
    this.entries.get(participantId).set(payload.round, entry);
    return structuredClone(entry);
  }

  control(action, payload = {}) {
    this.syncClock();
    if (action === 'open_hometown' && this.phase.startsWith('local_')) {
      this.localProgressAtHandoff = this.phase === 'local_open' ? 0 : this.elapsed() / this.clock.durationMs;
    }
    if (action === 'seek') {
      if (!this.phase.endsWith('_reveal') && !this.phase.endsWith('_rest') && this.phase !== 'complete') {
        throw new HttpError(409, 'Begin the shared view before moving through it.', 'invalid_transition');
      }
      const elapsedMs = payload.elapsedMs;
      if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > this.clock.durationMs) {
        throw new HttpError(400, 'Choose a point within this shared view.', 'invalid_seek');
      }
      this.clock = { ...this.clock, elapsedMs, startedAt: null, paused: true };
      this.phase = this.round + (elapsedMs === this.clock.durationMs ? '_rest' : '_reveal');
      this.revision += 1;
      return;
    }
    if (action === 'finish') {
      if (this.round !== 'hometown' || !this.phase.startsWith('hometown_')) {
        throw new HttpError(409, 'Open the hometown invitation before ending the offering.', 'invalid_transition');
      }
      this.clock = { ...this.clock, elapsedMs: this.clock.durationMs, startedAt: null, paused: true };
      this.phase = 'complete';
      this.revision += 1;
      return;
    }
    if (action === 'demo' && this.members.size && !this.demoMode) {
      throw new HttpError(409, 'A participant has joined. Start an empty room before loading examples.', 'room_not_empty');
    }
    super.control(action);
  }

  seedExamples() {
    super.seedExamples();
    for (const [participantId, rounds] of this.entries) {
      const first = [...rounds.values()][0];
      const member = { id: crypto.randomUUID(), displayName: first.displayName, joinedAt: first.createdAt, isExample: true };
      this.members.set(participantId, member);
      for (const entry of rounds.values()) {
        entry.memberId = member.id;
        entry.place.source = 'example-catalog';
        entry.place.detail = EXAMPLE_PLACES.find(place => place.label === entry.place.label)?.detail || '';
        entry.place.precision = entry.round === 'hometown' ? 'town' : 'point';
      }
    }
  }
}
