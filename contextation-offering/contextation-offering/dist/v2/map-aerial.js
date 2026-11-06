/* NYS ITS Geospatial Services orthoimagery. No API key. Each requested image
 * represents an actual Web Mercator tile extent; normal HTTP cache semantics
 * apply. Coverage and acquisition dates are supplied by the server config. */
const HALF_WORLD = 20037508.342789244;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function createAerialTiles(imagery, redraw, onError) {
  const cache = new Map();
  let destroyed = false, active = true, failures = 0, latest = [];
  function tile(z, x, y) {
    const count = 2 ** z, nx = ((x % count) + count) % count;
    if (y < 0 || y >= count) return null;
    const key = `${z}/${nx}/${y}`;
    let attempts = 1;
    if (cache.has(key)) {
      const cached = cache.get(key);
      if (!cached.failed || performance.now() - cached.failedAt < 12000 || cached.attempts >= 3) return cached;
      attempts = cached.attempts + 1;
      cache.delete(key);
    }
    const span = 2 * HALF_WORLD / count;
    const bbox = [nx * span - HALF_WORLD, HALF_WORLD - (y + 1) * span,
      (nx + 1) * span - HALF_WORLD, HALF_WORLD - y * span].join(',');
    const image = new Image(); image.crossOrigin = 'anonymous';
    const record = { image, ready: false, used: performance.now(), z, x: nx, y, attempts };
    cache.set(key, record);
    image.onload = () => { if (destroyed) return; record.ready = true; failures = 0; if (active) redraw(); };
    image.onerror = () => {
      if (destroyed) return;
      record.failed = true; record.failedAt = performance.now();
      if (++failures === 4) onError?.('aerial imagery is taking longer to arrive; the geographic map stays available.');
    };
    image.src = String(imagery.tileUrl).replace('{bbox-epsg-3857}', bbox)
      .replace('{z}', z).replace('{x}', nx).replace('{y}', y);
    if (cache.size > 160) {
      const stale = [...cache.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [id, old] of stale.slice(0, 32)) {
        old.image.onload = null; old.image.onerror = null; cache.delete(id);
      }
    }
    return record;
  }
  function mercator(point, zoom) {
    const size = 256 * 2 ** zoom, lat = clamp(point.lat, -85.05112878, 85.05112878) * Math.PI / 180;
    return [(point.lng + 180) / 360 * size, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * size];
  }
  function paintLevel(ctx, pose, size, z, request) {
    const scale = 2 ** (pose.zoom - z), center = mercator(pose, z), step = 256 * scale;
    const minX = Math.floor((center[0] - size.width / 2 / scale) / 256);
    const maxX = Math.floor((center[0] + size.width / 2 / scale) / 256);
    const minY = Math.floor((center[1] - size.height / 2 / scale) / 256);
    const maxY = Math.floor((center[1] + size.height / 2 / scale) / 256);
    if (!request) {
      // A large zoom-out must not scan millions of old-zoom tile positions.
      // There are at most 160 retained images; visit only those cached tiles.
      const count = 2 ** z;
      for (const record of cache.values()) {
        if (record.z !== z || !record.ready) continue;
        let x = record.x;
        while (x < minX - count / 2) x += count;
        while (x > maxX + count / 2) x -= count;
        if (x < minX || x > maxX || record.y < minY || record.y > maxY) continue;
        const left = size.width / 2 + (x * 256 - center[0]) * scale;
        const top = size.height / 2 + (record.y * 256 - center[1]) * scale;
        ctx.drawImage(record.image, left, top, step + .5, step + .5);
      }
      return 0;
    }
    let ready = 0, total = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const count = 2 ** z, nx = ((x % count) + count) % count;
      const record = tile(z, x, y);
      if (!record) continue;
      total++; record.used = performance.now();
      if (!record.ready) continue;
      const left = size.width / 2 + (x * 256 - center[0]) * scale;
      const top = size.height / 2 + (y * 256 - center[1]) * scale;
      ctx.drawImage(record.image, left, top, step + .5, step + .5); ready++;
    }
    return total ? ready / total : 0;
  }
  return {
    setActive(value) { active = Boolean(value); },
    retry() { for (const [key, record] of cache) if (record.failed) cache.delete(key); },
    draw(ctx, pose, size) {
      if (destroyed || !active) return 0;
      const zoom = clamp(Math.floor(pose.zoom), 7, Number(imagery.maxZoom) || 19);
      // Reuse the previous zoom while higher-resolution photographs arrive.
      for (const level of [...latest].sort((a, b) => a - b)) if (level !== zoom) paintLevel(ctx, pose, size, level, false);
      const coverage = paintLevel(ctx, pose, size, zoom, true);
      latest = [zoom, ...latest.filter(z => z !== zoom)].slice(0, 2);
      return coverage;
    },
    destroy() {
      destroyed = true;
      for (const record of cache.values()) { record.image.onload = null; record.image.onerror = null; }
      cache.clear();
    },
  };
}
