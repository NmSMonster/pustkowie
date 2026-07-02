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
};

export const TRUST = {
  low: 30, high: 70,
  lowFine: 2.5,          // compute/s drained by fines while below low
  highResearchBonus: 1.15,
  attackPenalty: 2, buildingKillPenalty: 4, victimSympathy: 2,
};

export const RESEARCHER_ASSIST = 0.45; // extra build speed per additional builder

// Node layout: two safe nodes near each corner base + contested middle ring.
export function makeNodes() {
  const n = [];
  const c = 46, m = 13;
  const corners = [[-c, -c], [c, -c], [-c, c], [c, c]];
  for (const [x, z] of corners) {
    n.push({ x: x + (x > 0 ? -m : m), z: z + (z > 0 ? -4 : 4), amount: 700 });
    n.push({ x: x + (x > 0 ? -4 : 4), z: z + (z > 0 ? -m : m), amount: 700 });
  }
  n.push({ x: 0, z: -20, amount: 1300 }, { x: 0, z: 20, amount: 1300 },
          { x: -20, z: 0, amount: 1300 }, { x: 20, z: 0, amount: 1300 },
          { x: 0, z: 0, amount: 2000 });
  return n;
}

export const BASES = [
  { x: -46, z: -46 }, { x: 46, z: -46 }, { x: -46, z: 46 }, { x: 46, z: 46 },
];
