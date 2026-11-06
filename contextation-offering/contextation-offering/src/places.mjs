
const EARTH_KM = 6371.0088;
const radians = (degrees) => degrees * Math.PI / 180;
export const PHOTON_ORIGIN = 'https://photon.komoot.io';

export function distanceKm(a, b) {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const t = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_KM * 2 * Math.asin(Math.min(1, Math.sqrt(t)));
}

export function approximateHome(place) {
  return {
    label: 'A neighborhood',
    lat: Number(place.lat.toFixed(2)),
    lng: Number(place.lng.toFixed(2)),
    kind: 'home',
    approximate: true,
  };
}

// Representative centers for trying the interface. These are examples, not
// participant contributions, and are labelled as such throughout the API.
export const EXAMPLE_PLACES = Object.freeze([
  { label: 'Thornden Park', detail: 'Syracuse, New York · example park center', lat: 43.0394, lng: -76.1218, kind: 'place' },
  { label: 'Onondaga Park', detail: 'Syracuse, New York · example park center', lat: 43.0242, lng: -76.1655, kind: 'place' },
  { label: 'Clinton Square', detail: 'Syracuse, New York · example square center', lat: 43.0514, lng: -76.1522, kind: 'place' },
  { label: 'Green Lakes State Park', detail: 'Fayetteville, New York · example park center', lat: 43.0483, lng: -75.9715, kind: 'place' },
  { label: 'Onondaga Lake Park', detail: 'Liverpool, New York · example park center', lat: 43.1069, lng: -76.2093, kind: 'place' },
  { label: 'Skaneateles', detail: 'New York, United States · example town center', lat: 42.9470, lng: -76.4291, kind: 'town' },
  { label: 'Syracuse', detail: 'New York, United States · example city center', lat: 43.0481, lng: -76.1474, kind: 'town' },
  { label: 'Richmond', detail: 'Virginia, United States · example city center', lat: 37.5407, lng: -77.4360, kind: 'town' },
  { label: 'St. Petersburg', detail: 'Florida, United States · example city center', lat: 27.7676, lng: -82.6403, kind: 'town' },
  { label: 'New York', detail: 'New York, United States · example city center', lat: 40.7128, lng: -74.0060, kind: 'town' },
  { label: 'London', detail: 'United Kingdom · example city center', lat: 51.5074, lng: -0.1278, kind: 'town' },
  { label: 'Amsterdam', detail: 'Netherlands · example city center', lat: 52.3676, lng: 4.9041, kind: 'town' },
  { label: 'Berlin', detail: 'Germany · example city center', lat: 52.5200, lng: 13.4050, kind: 'town' },
  { label: 'Tokyo', detail: 'Japan · example city center', lat: 35.6762, lng: 139.6503, kind: 'town' },
  { label: 'Mumbai', detail: 'India · example city center', lat: 19.0760, lng: 72.8777, kind: 'town' },
  { label: 'Buenos Aires', detail: 'Argentina · example city center', lat: -34.6037, lng: -58.3816, kind: 'town' },
  { label: 'Accra', detail: 'Ghana · example city center', lat: 5.6037, lng: -0.1870, kind: 'town' },
  { label: 'Sydney', detail: 'Australia · example city center', lat: -33.8688, lng: 151.2093, kind: 'town' },
].map((place) => Object.freeze({ ...place, source: 'example-catalog' })));

function normalized(text) {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function relevance(place, query) {
  const q = normalized(query);
  if (!q) return 0;
  const name = normalized(place.label);
  const detail = normalized(place.detail || '');
  if (name === q) return 1000;
  // A town followed by its state/country is still an exact place-name match.
  // Prefer it to another name that merely contains those same words.
  if (name && q.startsWith(name + ' ')) {
    const detailWords = new Set(detail.split(' '));
    if (q.slice(name.length + 1).split(' ').every(word => detailWords.has(word))) return 950;
  }
  if (name.startsWith(q)) return 800;
  if (name.includes(q)) return 600;
  const tokens = q.split(' ');
  return tokens.reduce((score, token) => score + (name.includes(token) ? 60 : detail.includes(token) ? 10 : 0), 0);
}

export function tidyPlaces(places, query, round, config) {
  const result = [];
  const seen = new Set();
  for (const place of places) {
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng) ||
        place.lat < -85 || place.lat > 85 || place.lng < -180 || place.lng > 180) continue;
    if (round === 'local' && distanceKm(config.center, place) > config.radiusKm) continue;
    if (round === 'hometown' && place.kind !== 'town') continue;
    const key = normalized(place.label) + '|' + place.lat.toFixed(3) + '|' + place.lng.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...place, distanceKm: Number(distanceKm(config.center, place).toFixed(2)) });
  }
  result.sort((a, b) => relevance(b, query) - relevance(a, query) || a.distanceKm - b.distanceKm || a.label.localeCompare(b.label));
  return result.slice(0, 12);
}

export function examplePlaces(query, round, config) {
  const matches = EXAMPLE_PLACES.filter((place) => !query || relevance(place, query) > 0);
  return tidyPlaces(matches, query, round, config);
}

function formatPhoton(feature, query, round) {
  const p = feature?.properties;
  const coordinates = feature?.geometry?.coordinates;
  if (!p || feature.geometry?.type !== 'Point' || !Array.isArray(coordinates)) return null;
  const [lng, lat] = coordinates;
  const addressQuery = /\d/.test(query) || /\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|way|court|ct)\b/i.test(query);
  const addressResult = p.type === 'house' || p.type === 'street' || Boolean(p.housenumber);
  const locality = p.city || p.town || p.village || p.district || '';
  let label = p.name;
  if (addressQuery && addressResult && p.street) label = [p.housenumber, p.street].filter(Boolean).join(' ');
  if (!label) label = locality || p.county || p.state || p.country;
  if (!label || (addressResult && !addressQuery && !p.name)) return null;
  // Photon's locality layer also contains industrial/commercial areas and
  // neighborhoods. Keep actual settlements for the hometown invitation.
  const town = ['city', 'town', 'village', 'hamlet', 'locality', 'municipality'].includes(p.osm_value) ||
    p.type === 'city';
  const detailParts = [locality, p.state, p.country].filter((value) => value && value !== label);
  if (addressQuery && p.street && !label.includes(p.street)) detailParts.unshift([p.housenumber, p.street].filter(Boolean).join(' '));
  return {
    label: String(label).slice(0, 160),
    detail: [...new Set(detailParts)].join(', ').slice(0, 240),
    lat, lng, kind: town ? 'town' : 'place', source: 'photon',
  };
}

export class PlaceSearch {
  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, formatFeature = formatPhoton, tidy = tidyPlaces } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.formatFeature = formatFeature;
    this.tidy = tidy;
    this.cache = new Map();
    this.pending = new Map();
  }

  async search(query, round, source) {
    if (source === 'examples' || !query) {
      return {
        results: examplePlaces(query, round, this.config),
        source: 'example-catalog',
        notice: 'Example places for trying the experience. Search by name for other places.',
      };
    }
    // A digest keeps raw typed search terms out of cache keys.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(round + '\n' + query.toLowerCase()));
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const request = this.request(query, round).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    const result = await request;
    // Avoid caching street/address searches. Nothing is written to disk.
    if (!/\d/.test(query)) {
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { value: result, expires: this.now() + (result.source === 'photon' ? 300000 : 15000) });
    }
    return result;
  }

  async request(query, round) {
    const url = new URL('/api/', PHOTON_ORIGIN);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '30');
    url.searchParams.set('lang', 'en');
    if (round === 'local') {
      const { lat, lng } = this.config.center;
      const latSpan = this.config.radiusKm / 110.574;
      const lngSpan = this.config.radiusKm / (111.32 * Math.cos(radians(lat)));
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lng));
      url.searchParams.set('bbox', [lng - lngSpan, lat - latSpan, lng + lngSpan, lat + latSpan].join(','));
    } else {
      url.searchParams.append('layer', 'city');
      url.searchParams.append('layer', 'locality');
    }
    try {
      const response = await this.fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json', 'User-Agent': 'contextation-offering/2.0 (class exercise)' },
      });
      if (!response.ok) throw new Error('Search unavailable');
      const body = await response.json();
      if (!Array.isArray(body.features)) throw new Error('Invalid search response');
      return {
        results: this.tidy(body.features.map((feature) => this.formatFeature(feature, query, round)).filter(Boolean), query, round, this.config),
        source: 'photon',
      };
    } catch {
      return {
        results: examplePlaces(query, round, this.config),
        source: 'example-catalog',
        notice: 'Live place search is unavailable. These are matching example places; you can also browse the example list or choose on the map.',
      };
    }
  }
}
