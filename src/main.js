// Orchestrator: menu -> sim + world + input + hud + audio -> game loop.
import { Sim } from './sim/sim.js';
import { makeAIs } from './sim/ai.js';
import { loadAssets } from './render/assets.js';
import { World } from './render/world.js';
import { initInput } from './input.js';
import { initHud, showMenu } from './ui/hud.js';
import { initAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');

const state = {
  sim: null, world: null, ais: [], input: null, hud: null, audio: null,
  selection: new Set(), running: false, paused: false, speed: 1,
};
window.__game = state; // debug/testing hook

async function startGame(factionId) {
  state.sim = new Sim(factionId, Date.now() % 100000);
  if (params.get('spectate')) state.sim.factions[factionId].isPlayer = false;
  state.ais = makeAIs(state.sim);
  state.world = new World(state.sim, canvas);
  initInput(state, canvas);
  initHud(state);
  state.audio = await initAudio();
  state.running = true;
  state.speed = parseFloat(params.get('speed') || '1');
}

let last = performance.now();
let acc = 0;
const SIM_DT = 0.1;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state.running) return;

  if (!state.paused && !state.sim.over) {
    acc += dt * state.speed;
    let steps = 0;
    while (acc >= SIM_DT && steps < 60) {
      state.sim.tick(SIM_DT);
      for (const ai of state.ais) ai.tick(SIM_DT);
      acc -= SIM_DT; steps++;
    }
  }

  // fan events out to consumers, then drain
  const ev = state.sim.events;
  if (ev.length) {
    state.world.applyEvents(ev);
    state.hud?.applyEvents(ev);
    state.audio?.applyEvents(ev, state);
    ev.length = 0;
  }

  // drop dead ids from selection
  let selChanged = false;
  for (const id of state.selection) {
    const e = state.sim.getEntity(id);
    if (!e || e.dead) { state.selection.delete(id); selChanged = true; }
  }
  if (selChanged) state.hud?.refreshSelection();

  state.input?.update(dt);
  state.world.sync(dt, state.selection);
  state.hud?.update(dt);
  state.world.render();
}

(async () => {
  await loadAssets();
  window.__assetsReady = true;
  if (params.get('spectate')) {
    await startGame(params.get('faction') || 'anthropic');
    let t = 0;
    setInterval(() => {
      t += 0.016;
      const w = state.world;
      if (!w) return;
      w.camYaw += 0.0012;
      if (params.get('follow') !== '0') {
        w.camFocus.x += (Math.sin(t * 0.05) * 30 - w.camFocus.x) * 0.002;
        w.camFocus.z += (Math.cos(t * 0.04) * 30 - w.camFocus.z) * 0.002;
      }
    }, 16);
  } else if (params.get('faction')) {
    await startGame(params.get('faction'));
  } else {
    showMenu(startGame);
  }
  requestAnimationFrame(loop);
})();

state.startGame = startGame;
