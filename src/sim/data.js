// Static game data — the metaphor made mechanical.
// Labs race to SUPERINTELLIGENCE by converting Compute + Data + Talent into
// frontier milestones, while Trust (public perception) and Favor (government
// goodwill) gate how dirty they can play.

export const MAP = { size: 132, half: 66 };

export const FACTIONS = {
  openai: {
    id: 'openai', name: 'OpenAI', short: 'OAI',
    color: 0x19c39c, css: '#19c39c',
    motto: 'Scale is all you need',
    bonusName: 'Blitzscale',
    bonusDesc: '+25% compute income, research 10% faster — but public trust slowly erodes.',
    computeMult: 1.25, researchMult: 1.10, trustDrift: -0.25,
    ai: { aggression: 0.45, econ: 0.75, tech: 0.95, trustCare: 0.3 },
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic', short: 'ANT',
    color: 0xe08a63, css: '#e08a63',
    motto: 'Race carefully',
    bonusName: 'Constitutional',
    bonusDesc: 'Trust never falls below 45 and regenerates; +20% research while trust is high.',
    trustFloor: 45, trustDrift: +0.5, highTrustResearch: 1.20,
    ai: { aggression: 0.2, econ: 0.7, tech: 0.85, trustCare: 0.95 },
  },
  deepmind: {
    id: 'deepmind', name: 'Google DeepMind', short: 'GDM',
    color: 0x5b9bff, css: '#5b9bff',
    motto: 'Solve intelligence',
    bonusName: 'TPU Empire',
    bonusDesc: 'Buildings cost 20% less, datastream nodes yield +25%, towers reach further.',
    buildDiscount: 0.8, dataYield: 1.25, towerRange: 1.25,
    ai: { aggression: 0.35, econ: 0.95, tech: 0.8, trustCare: 0.6 },
  },
  xai: {
    id: 'xai', name: 'xAI', short: 'XAI',
    color: 0xff4059, css: '#ff4059',
    motto: 'Move fast, break alignment',
    bonusName: 'Ship It',
    bonusDesc: 'Units train 30% faster and agents hit +15% harder — but trust bleeds away.',
    trainMult: 0.7, agentDamage: 1.15, trustDrift: -0.35,
    ai: { aggression: 0.9, econ: 0.55, tech: 0.65, trustCare: 0.3 },
  },
};

export const START = { compute: 320, data: 160, favor: 0, trust: 60 };

export const UNITS = {
  researcher: {
    name: 'Researcher', hp: 55, speed: 4.6, cost: { compute: 80 }, buildTime: 9,
    radius: 0.55, gatherRate: 0.8, buildRate: 1.0, pop: 1,
  },
  agent: {
    name: 'Agent', hp: 95, speed: 5.6, cost: { compute: 110, data: 35 }, buildTime: 11,
    radius: 0.6, dmg: 16, cooldown: 1.4, range: 2.3, aggro: 11, pop: 1,
  },
  sentinel: {
    name: 'Sentinel', hp: 150, speed: 5.0, cost: { compute: 170, data: 60 }, buildTime: 15,
    radius: 0.6, dmg: 11, cooldown: 0.75, range: 9.5, aggro: 12, pop: 1, needsMilestone: 2,
  },
  interceptor: {
    name: 'Interceptor', hp: 80, speed: 6.0, cost: { compute: 140, data: 50 }, buildTime: 13,
    radius: 0.55, dmg: 9, cooldown: 0.9, range: 6.2, aggro: 12, pop: 1, needsMilestone: 1,
    bonusVs: 'agent', bonusMult: 2.2, slows: true,
  },
};

// Counter triangle: Agents crush Sentinels up close, Sentinels outrange
// Interceptors, Interceptors EMP-burst Agents (bonus damage + slow).
export const SIGHT = {
  researcher: 11, agent: 12, sentinel: 14, interceptor: 13,
  hq: 16, datacenter: 13, campus: 13, foundry: 13, lobby: 13, synth: 13, tower: 18,
};

export const BUILDINGS = {
  hq: {
    name: 'Frontier Lab', hp: 1400, cost: {}, buildTime: 0, size: 3.4,
    income: { compute: 2.6 }, talentCap: 6,
    desc: 'Your lab. Trains researchers, runs frontier training. Lose it and the lab folds.',
  },
  datacenter: {
    name: 'Compute Cluster', hp: 480, cost: { compute: 180 }, buildTime: 18, size: 2.6,
    income: { compute: 5.5 },
    desc: 'Racks of accelerators. Generates a steady stream of compute.',
  },
  campus: {
    name: 'Talent Campus', hp: 380, cost: { compute: 150 }, buildTime: 14, size: 2.4,
    talentCap: 5, income: { trust: 0.02 },
    desc: 'Perks, papers and ping-pong. Raises your researcher cap by 5.',
  },
  foundry: {
    name: 'Agent Foundry', hp: 450, cost: { compute: 220, data: 60 }, buildTime: 20, size: 2.6,
    desc: 'Spins up autonomous agents — your offense and defense.',
  },
  lobby: {
    name: 'Policy Office', hp: 350, cost: { compute: 160 }, buildTime: 15, size: 2.2,
    income: { favor: 0.55 },
    desc: 'Suits in the capital. Generates government favor for regulatory plays.',
  },
  synth: {
    name: 'Synthetic Data Plant', hp: 400, cost: { compute: 260 }, buildTime: 20, size: 2.4,
    needsMilestone: 2, synth: { computeIn: 4.0, dataOut: 3.0 },
    desc: 'When the web runs dry, brew your own data. Converts compute into data.',
  },
  tower: {
    name: 'Firewall Tower', hp: 560, cost: { compute: 190, data: 40 }, buildTime: 16, size: 1.6,
    attack: { dmg: 22, cooldown: 1.0, range: 12.5 },
    desc: 'Automated cyberdefense. Zaps intruding agents.',
  },
};

export const MILESTONES = [
  { name: 'Multimodal Foundation Model', short: 'Foundation', cost: { compute: 260, data: 240 }, time: 42,
    perk: '+10% all income', desc: 'The scaling curve bends in your favor.' },
  { name: 'Advanced Reasoning', short: 'Reasoning', cost: { compute: 420, data: 300 }, time: 55,
    perk: 'Unlocks Sentinels & Synthetic Data Plant', desc: 'It thinks before it speaks.' },
  { name: 'Autonomous Agents', short: 'Agents', cost: { compute: 700, data: 520 }, time: 68,
    perk: 'Agents +25% damage, +15% speed', desc: 'It acts on its own. Mostly as intended.' },
  { name: 'Recursive Self-Improvement', short: 'Recursion', cost: { compute: 1050, data: 780 }, time: 80,
    perk: 'Research +40%, income +20%', desc: 'It writes better versions of itself. Faster.' },
  { name: 'SUPERINTELLIGENCE', short: 'ASI', cost: { compute: 1500, data: 950 }, time: 105,
    perk: 'Victory', desc: 'The final training run. Everyone will know you started it.' },
];

export const ABILITIES = {
  poach: {
    name: 'Poach Talent', building: 'hq', cost: { compute: 150 }, trustCost: 8, cooldown: 55,
    desc: 'Flip a rival researcher to your lab with an offer they can\'t refuse. Costs trust.',
  },
  probe: {
    name: 'Regulatory Probe', building: 'lobby', cost: { favor: 60 }, trustCost: 5, cooldown: 40,
    desc: 'Sic the regulators on a rival: their compute income halved for 30s.',
  },
  subsidy: {
    name: 'State Subsidy', building: 'lobby', cost: { favor: 45 }, cooldown: 30,
    desc: 'Call in a favor: +180 compute immediately.',
  },
  pr: {
    name: 'PR Campaign', building: 'lobby', cost: { favor: 30 }, cooldown: 25,
    desc: 'Glossy launch video, friendly podcast circuit: +12 trust.',
  },
  scrape: {
    name: 'Web Scrape', building: 'hq', cost: {}, trustCost: 10, cooldown: 45,
    desc: 'Hoover the open web, robots.txt be damned: +150 data, −10 trust.',
  },
  license: {
    name: 'Licensed Data', building: 'hq', cost: { compute: 200 }, cooldown: 45,
    desc: 'Pay publishers like a good citizen: +150 data, +3 trust.',
  },
  infiltrate: {
    name: 'Infiltrate', building: 'lobby', cost: { favor: 50 }, cooldown: 60,
    desc: 'Plant a mole in a rival lab: reveal their base and books for 30s.',
  },
};

export const TRUST = {
  low: 30, high: 70,
  lowFine: 2.5,          // compute/s drained by fines while below low
  highResearchBonus: 1.15,
  attackPenalty: 2, buildingKillPenalty: 4, victimSympathy: 2,
};

export const RESEARCHER_ASSIST = 0.45; // extra build speed per additional builder

// Global "the world reacts" events — same headlines hit every lab at once.
export const WORLD_EVENTS = {
  chipban: { name: 'Chip Export Ban', icon: '🚢', dur: 30, desc: 'GPU shipments seized at port — all compute income −40% for 30s.' },
  leak:    { name: 'Open-Source Leak', icon: '📂', dur: 0,  desc: 'A frontier model leaks overnight — every lab gains +200 data.' },
  winter:  { name: 'AI Winter Scare', icon: '❄️', dur: 30, desc: '"Is deep learning hitting a wall?" — all research 50% slower for 30s.' },
  frenzy:  { name: 'VC Frenzy', icon: '💸', dur: 0,  desc: 'Money is free again — every lab gains +220 compute.' },
  hearing: { name: 'Congressional Hearing', icon: '⚖️', dur: 0,  desc: 'The race leader gets grilled on live TV — leader loses 12 trust.' },
  flare:   { name: 'Solar Flare', icon: '🌞', dur: 20, desc: 'Geomagnetic storm — all firewall towers offline for 20s.' },
};

// Non-aggression pacts: shared infra income while active; breaking one by
// force is a betrayal the public does not forget.
export const PACT = { duration: 100, income: 0.6, betrayTrustCost: 8, proposeCost: 30, offerTime: 25 };

// Node layouts — three map scripts with different economic geography.
export const MAP_VARIANTS = {
  classic: 'Classic Crossfire',
  scarce: 'Scarce Center',
  ring: 'Data Ring',
};

export function makeNodes(variant = 'classic') {
  const n = [];
  const c = 46, m = 13;
  const corners = [[-c, -c], [c, -c], [-c, c], [c, c]];
  if (variant === 'scarce') {
    // starved corners, one rich contested heart
    for (const [x, z] of corners) {
      n.push({ x: x + (x > 0 ? -m : m), z: z + (z > 0 ? -4 : 4), amount: 500 });
    }
    n.push({ x: 0, z: 0, amount: 3400 },
            { x: -9, z: 9, amount: 1700 }, { x: 9, z: -9, amount: 1700 });
  } else if (variant === 'ring') {
    // an even ring — every neighbor is a border dispute
    for (const [x, z] of corners) {
      n.push({ x: x + (x > 0 ? -m : m), z: z + (z > 0 ? -4 : 4), amount: 600 });
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      n.push({ x: Math.cos(a) * 28, z: Math.sin(a) * 28, amount: 1050 });
    }
  } else {
    for (const [x, z] of corners) {
      n.push({ x: x + (x > 0 ? -m : m), z: z + (z > 0 ? -4 : 4), amount: 700 });
      n.push({ x: x + (x > 0 ? -4 : 4), z: z + (z > 0 ? -m : m), amount: 700 });
    }
    n.push({ x: 0, z: -20, amount: 1300 }, { x: 0, z: 20, amount: 1300 },
            { x: -20, z: 0, amount: 1300 }, { x: 20, z: 0, amount: 1300 },
            { x: 0, z: 0, amount: 2000 });
  }
  return n;
}

// AI difficulty knobs (applied to AI factions only)
export const DIFFICULTY = {
  easy:   { name: 'Easy',   income: 0.85, aggro: -0.18, raidDelay: 90 },
  normal: { name: 'Normal', income: 1.0,  aggro: 0,     raidDelay: 0 },
  hard:   { name: 'Hard',   income: 1.15, aggro: 0.15,  raidDelay: -60 },
};

export const BASES = [
  { x: -46, z: -46 }, { x: 46, z: -46 }, { x: -46, z: 46 }, { x: 46, z: 46 },
];
