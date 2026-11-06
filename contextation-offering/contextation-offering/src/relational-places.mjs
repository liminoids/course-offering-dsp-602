import { PlaceSearch, distanceKm } from './places.mjs';
import { HttpError } from './errors.mjs';

const text = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const normalized = value => text(value, 400).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const settlements = new Set(['city', 'town', 'village', 'hamlet', 'municipality']);
const publicKinds = new Set(['amenity', 'leisure', 'shop', 'tourism', 'historic', 'natural', 'office', 'railway', 'aeroway']);

export function formatRelationalPlace(feature, query, round) {
  const p = feature?.properties;
  const coordinates = feature?.geometry?.coordinates;
  if (!p || feature.geometry?.type !== 'Point' || !Array.isArray(coordinates)) return null;
  const [lng, lat] = coordinates;
  const settlement = (p.osm_key === 'place' && settlements.has(p.osm_value)) || (p.type === 'city' && !['industrial', 'commercial', 'suburb', 'neighbourhood'].includes(p.osm_value));
  if (round === 'hometown' && !settlement) return null;
  const addressQuery = /\d/.test(query);
  const street = p.osm_key === 'highway' || p.type === 'street';
  if (street && !addressQuery) return null;
  const publicPlace = publicKinds.has(p.osm_key) && Boolean(p.name);
  const address = !publicPlace && (p.type === 'house' || Boolean(p.housenumber));
  const locality = text(p.city || p.town || p.village || p.district || '');
  let label = text(p.name);
  if (address && p.street) label = text([p.housenumber, p.street].filter(Boolean).join(' '));
  if (!label) label = locality || text(p.county || p.state || p.country);
  if (!label || (address && !addressQuery)) return null;
  const detail = [p.district, publicPlace ? p.street : '', locality, p.state, p.country].map(value => text(value)).filter(value => value && value !== label);
  const osmType = { N: 'N', W: 'W', R: 'R', node: 'N', way: 'W', relation: 'R' }[p.osm_type];
  return {
    label, detail: [...new Set(detail)].join(', ').slice(0, 240), lat, lng,
    kind: settlement ? 'town' : address ? 'home' : 'place',
    source: 'photon', precision: settlement ? 'town' : address ? 'address' : 'point',
    category: text(p.osm_value, 60),
    ...(osmType && /^\d{1,20}$/.test(String(p.osm_id)) ? { osmId: osmType + p.osm_id } : {}),
  };
}

function rank(place, query) {
  const q = normalized(query), name = normalized(place.label), detail = normalized(place.detail);
  if (q === name) return 5;
  if (name && q.startsWith(name + ' ') && q.slice(name.length + 1).split(' ').every(word => detail.split(' ').includes(word))) return 5;
  if (name.startsWith(q)) return 4;
  if (q.split(' ').every(word => name.split(' ').includes(word))) return 3;
  if (name.includes(q)) return 2;
  return q.split(' ').every(word => (name + ' ' + detail).includes(word)) ? 1 : 0;
}

export function tidyRelationalPlaces(places, query, round, config) {
  const valid = places.filter(place => place && Number.isFinite(place.lat) && Number.isFinite(place.lng) &&
    Math.abs(place.lat) <= 85 && Math.abs(place.lng) <= 180 && (round !== 'hometown' || place.kind === 'town') &&
    (round !== 'local' || distanceKm(config.center, place) <= config.radiusKm))
    .map(place => ({ ...place, distanceKm: Math.round(distanceKm(config.center, place) * 100) / 100 }));
  valid.sort((a, b) => rank(b, query) - rank(a, query) || a.distanceKm - b.distanceKm || a.label.localeCompare(b.label));
  const result = [];
  for (const place of valid) {
    if (result.some(other => (place.osmId && other.osmId === place.osmId) ||
      (normalized(other.label) === normalized(place.label) && other.kind === place.kind && distanceKm(other, place) < .2))) continue;
    result.push(place);
    if (result.length === 12) break;
  }
  return result;
}

export class RelationalPlaceSearch extends PlaceSearch {
  constructor(config, options = {}) {
    super(config, { ...options, formatFeature: formatRelationalPlace, tidy: tidyRelationalPlaces });
  }
  async search(query, round, source) {
    if (!query && source !== 'examples') return { results: [], source: 'photon' };
    const result = await super.search(query, round, source);
    if (source !== 'examples' && result.source !== 'photon') {
      return { results: [], source: 'unavailable', notice: 'Place search is resting. Try again, or choose your place on the map.' };
    }
    return result;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const keyFor = password => crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const signedBytes = (origin, body) => encoder.encode('offering-place-selection-v2\n' + origin + '\n' + body);

export async function signPlace(place, round, origin, password, now = Date.now()) {
  const body = toBase64(encoder.encode(JSON.stringify({ round, expires: now + 2 * 60 * 60 * 1000, place })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(password), signedBytes(origin, body)));
  return { ...place, selectionToken: body + '.' + toBase64(signature) };
}

// A posted provider label is not evidence. Preserve provider metadata only when
// it came from our search response, with its point/label/round bound together.
export async function verifiedPlace(input, round, origin, password, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Choose a place before sharing.', 'invalid_place');
  if (!input.selectionToken) {
    return { label: input.label, lat: input.lat, lng: input.lng, kind: input.kind ?? (round === 'hometown' ? 'town' : 'place'),
      source: 'map', detail: '', precision: round === 'hometown' ? 'town' : 'point' };
  }
  try {
    if (typeof input.selectionToken !== 'string' || input.selectionToken.length > 4096) throw new Error();
    const [body, signature, extra] = input.selectionToken.split('.');
    if (extra || !body || !signature || !await crypto.subtle.verify('HMAC', await keyFor(password), fromBase64(signature), signedBytes(origin, body))) throw new Error();
    const signed = JSON.parse(decoder.decode(fromBase64(body)));
    if (signed.round !== round || !Number.isFinite(signed.expires) || signed.expires <= now || signed.expires > now + 2 * 60 * 60 * 1000) throw new Error();
    // Choosing privacy can only reduce precision, never turn an address into a POI.
    return { ...signed.place, ...(input.kind === 'home' ? { kind: 'home' } : {}) };
  } catch {
    throw new HttpError(400, 'Please select that place again before sharing.', 'invalid_selection');
  }
}
