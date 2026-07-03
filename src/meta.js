// Meta progression: persistent lab career across matches.
// XP -> account levels -> titles + unlocks (skins, Insane difficulty,
// spectate). Faction mastery stars track wins per lab. All in localStorage.
import { settings, saveSettings } from './settings.js';

export const TITLES = [
  'Intern', 'Prompt Engineer', 'Research Assistant', 'ML Engineer',
  'Senior Researcher', 'Principal Scientist', 'Head of Frontier Lab',
  'VP of Research', 'Chief Scientist', 'Architect of Superintelligence',
];

// cumulative XP needed to REACH level i+2 (level 1 is free)
export const LEVEL_XP = [150, 400, 760, 1240, 1850, 2600, 3500, 4560, 5800];
export const MAX_LEVEL = TITLES.length;

export const UNLOCKS = {
  2: { icon: '🎨', name: 'Neon skins', desc: 'Alternate faction palette (pick on the faction card)' },
  3: { icon: '📺', name: 'Spectate mode', desc: 'Watch four AIs race from the menu' },
  4: { icon: '🌑', name: 'Stealth skins', desc: 'Second faction palette' },
  5: { icon: '💀', name: 'Insane difficulty', desc: 'The AIs stop being polite' },
  6: { icon: '👑', name: 'Gilded skins', desc: 'Third faction palette' },
};

// Alternate palettes per skin tier; base colors live in FACTIONS.
export const SKINS = {
  default: { name: 'Factory', level: 1, colors: null },
  neon: {
    name: 'Neon', level: 2,
    colors: {
      openai: 0x2affd4, anthropic: 0xffa04d, deepmind: 0x7fb5ff, xai: 0xff2e8a,
    },
  },
  stealth: {
    name: 'Stealth', level: 4,
    colors: {
      openai: 0x2e6b5e, anthropic: 0x8a5a44, deepmind: 0x3d5a8a, xai: 0x8a2438,
    },
  },
  gilded: {
    name: 'Gilded', level: 6,
    colors: {
      openai: 0xd4c06a, anthropic: 0xe8b04d, deepmind: 0xc9a94f, xai: 0xe8a03a,
    },
  },
};

export const MASTERY_WINS = [1, 3, 6, 10, 15]; // wins per star

export function meta() {
  if (!settings.meta) settings.meta = { xp: 0, matches: 0, wins: 0, factions: {}, skins: {} };
  settings.meta.factions = settings.meta.factions || {};
  settings.meta.skins = settings.meta.skins || {};
  return settings.meta;
}

export function levelFromXp(xp) {
  let lvl = 1;
  for (const need of LEVEL_XP) { if (xp >= need) lvl++; else break; }
  return Math.min(MAX_LEVEL, lvl);
}

export function levelProgress(xp) {
  const lvl = levelFromXp(xp);
  if (lvl >= MAX_LEVEL) return { lvl, cur: 1, need: 1, frac: 1 };
  const prev = lvl === 1 ? 0 : LEVEL_XP[lvl - 2];
  const next = LEVEL_XP[lvl - 1];
  return { lvl, cur: xp - prev, need: next - prev, frac: (xp - prev) / (next - prev) };
}

export function masteryStars(fid) {
  const wins = meta().factions[fid]?.wins || 0;
  let stars = 0;
  for (const w of MASTERY_WINS) { if (wins >= w) stars++; else break; }
  return stars;
}

export function skinUnlocked(skinId) {
  return levelFromXp(meta().xp) >= (SKINS[skinId]?.level || 99);
}

export function chosenSkin(fid) {
  const id = meta().skins[fid] || 'default';
  return skinUnlocked(id) ? id : 'default';
}

// Grant XP for a finished match; idempotent per match via caller's flag.
export function grantMatchXp(sim, playerFid, achievementsUnlocked = 0) {
  const m = meta();
  const f = sim.fac(playerFid);
  const won = sim.winner === playerFid;
  const diffMult = { easy: 0.7, normal: 1, hard: 1.3, insane: 1.6 }[sim.difficulty.key || 'normal'] || 1;

  const parts = [];
  let xp = 40; parts.push(['Match played', 40]);
  if (won) { xp += 120; parts.push(['Victory', 120]); }
  if (f.milestone > 0) { const v = f.milestone * 25; xp += v; parts.push([`Milestones ×${f.milestone}`, v]); }
  const killXp = Math.min(60, f.stats.kills * 2);
  if (killXp > 0) { xp += killXp; parts.push([`Kills ×${f.stats.kills}`, killXp]); }
  if (achievementsUnlocked > 0) { const v = achievementsUnlocked * 50; xp += v; parts.push([`Achievements ×${achievementsUnlocked}`, v]); }
  if (diffMult !== 1) parts.push([`Difficulty ×${diffMult}`, null]);
  xp = Math.round(xp * diffMult);

  const before = levelFromXp(m.xp);
  m.xp += xp;
  m.matches++;
  if (won) m.wins++;
  const fm = m.factions[playerFid] = m.factions[playerFid] || { games: 0, wins: 0 };
  fm.games++;
  if (won) fm.wins++;
  const after = levelFromXp(m.xp);

  const newUnlocks = [];
  for (let l = before + 1; l <= after; l++) if (UNLOCKS[l]) newUnlocks.push({ level: l, ...UNLOCKS[l] });

  saveSettings({ meta: m });
  return { xp, parts, before, after, newUnlocks, total: m.xp };
}
