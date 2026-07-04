// Persistent player settings (localStorage).
const KEY = 'asi_rts_settings_v1';

const DEFAULTS = {
  master: 0.9,     // master volume 0..1
  music: 0.5,      // music volume 0..1
  quality: 'auto', // 'auto' | 'high' | 'low'
  faction: null,   // last played faction id
  difficulty: 'normal',
  map: 'classic',
  achievements: {},
  tutorialDone: false,
  meta: null,      // lab career: xp, wins, faction mastery, chosen skins
  reduceMotion: false, // accessibility: damp screen shake & heavy particles
  uiScale: 1,          // HUD scale 0.8..1.4
  colorblind: false,   // colorblind-safe faction palette
  gameSpeed: 1,        // preferred default game speed
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* private mode etc. */ }
  return { ...DEFAULTS };
}

export const settings = load();

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  for (const fn of listeners) fn(settings);
}

const listeners = new Set();
export function onSettingsChange(fn) { listeners.add(fn); }
