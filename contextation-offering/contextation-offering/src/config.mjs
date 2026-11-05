
export const DEFAULT_CONFIG = Object.freeze({
  title: 'Offering',
  center: Object.freeze({ label: 'Whitman · Syracuse', lat: 43.0421035, lng: -76.1339149 }),
  radiusKm: 64.3736,
  inhaleMs: 5000,
  exhaleMs: 5000,
  localDurationMs: 50000,
  hometownDurationMs: 60000,
});

export function validateConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input, center: { ...DEFAULT_CONFIG.center, ...input.center } };
  if (typeof config.title !== 'string' || config.title.length > 80 || !config.title.trim()) {
    throw new Error('config.json: title must contain 1–80 characters.');
  }
  if (typeof config.center.label !== 'string' || config.center.label.length > 120 || !config.center.label.trim()) {
    throw new Error('config.json: center.label must contain 1–120 characters.');
  }
  if (!Number.isFinite(config.center.lat) || config.center.lat < -85 || config.center.lat > 85 ||
      !Number.isFinite(config.center.lng) || config.center.lng < -180 || config.center.lng > 180) {
    throw new Error('config.json: center needs valid numeric latitude and longitude.');
  }
  for (const key of ['radiusKm', 'inhaleMs', 'exhaleMs', 'localDurationMs', 'hometownDurationMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error('config.json: ' + key + ' must be positive.');
  }
  if (config.radiusKm > 1000) throw new Error('config.json: local radius must be 1000 km or less.');
  config.title = config.title.trim();
  config.center.label = config.center.label.trim();
  return config;
}
