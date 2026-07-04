// Accessibility application: colorblind-safe faction palette + HUD scale +
// reduce-motion. Kept in its own module so both main.js and the HUD can call
// it without a circular import.
import { settings } from './settings.js';
import { FACTIONS, COLORBLIND } from './sim/data.js';

const BASE_FACTION_COLORS = Object.fromEntries(
  Object.keys(FACTIONS).map(id => [id, FACTIONS[id].color]));

export function applyAccessibility() {
  for (const id in FACTIONS) {
    const c = settings.colorblind ? COLORBLIND[id] : BASE_FACTION_COLORS[id];
    FACTIONS[id].color = c;
    FACTIONS[id].css = '#' + c.toString(16).padStart(6, '0');
  }
  document.documentElement.style.setProperty('--ui-scale', settings.uiScale || 1);
  if (window.__game?.world) window.__game.world.reduceMotion = !!settings.reduceMotion;
}
