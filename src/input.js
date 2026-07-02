// Trackpad-first input: two-finger scroll pans, pinch zooms, two-finger tap
// (contextmenu) issues smart commands. Click/drag selects. Keyboard fallbacks.
import { UNITS, BUILDINGS } from './sim/data.js';

export function initInput(state, canvas) {
  const world = () => state.world;
  const sim = () => state.sim;

  const input = {
    keys: new Set(),
    dragStart: null, dragging: false,
    buildMode: null,      // building kind being placed
    abilityMode: null,    // ability key awaiting a target
    ghost: null,
    update,
  };
  state.input = input;

  const boxEl = document.createElement('div');
  boxEl.id = 'selbox';
  document.getElementById('hud').appendChild(boxEl);

  // ---------- helpers ----------
  const ndc = (e) => ({
    x: (e.clientX / window.innerWidth) * 2 - 1,
    y: -(e.clientY / window.innerHeight) * 2 + 1,
  });
  const myUnits = (ids) => [...ids].filter(id => {
    const u = sim().units.find(v => v.id === id);
    return u && u.faction === sim().playerFaction;
  });

  function selectableAt(e) {
    const hit = world().pick(ndc(e).x, ndc(e).y);
    return hit;
  }

  function setSelection(ids, additive = false) {
    if (!additive) state.selection.clear();
    for (const id of ids) state.selection.add(id);
    state.hud?.refreshSelection?.();
  }

  // ---------- pointer ----------
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    input.dragStart = { x: e.clientX, y: e.clientY };
    input.dragging = false;
  });

  window.addEventListener('mousemove', (e) => {
    input.mouse = { x: e.clientX, y: e.clientY };
    if (input.dragStart && !input.buildMode) {
      const dx = e.clientX - input.dragStart.x, dy = e.clientY - input.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) input.dragging = true;
      if (input.dragging) {
        const x0 = Math.min(input.dragStart.x, e.clientX), y0 = Math.min(input.dragStart.y, e.clientY);
        boxEl.style.cssText = `display:block;left:${x0}px;top:${y0}px;width:${Math.abs(dx)}px;height:${Math.abs(dy)}px`;
      }
    }
    // build ghost follows cursor
    if (input.buildMode && world()) {
      const p = world().groundPoint(ndc(e).x, ndc(e).y);
      if (p) world().moveGhost(input.buildMode, p.x, p.z, sim().placementValid(input.buildMode, p.x, p.z));
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !input.dragStart) return;
    const wasDrag = input.dragging;
    const start = input.dragStart;
    input.dragStart = null; input.dragging = false;
    boxEl.style.display = 'none';

    if (input.buildMode) {
      const p = world().groundPoint(ndc(e).x, ndc(e).y);
      if (p && sim().placementValid(input.buildMode, p.x, p.z)) {
        const builders = myUnits(state.selection).filter(id => {
          const u = sim().units.find(v => v.id === id);
          return u && u.kind === 'researcher';
        });
        const b = sim().cmdBuild(sim().playerFaction, input.buildMode, p.x, p.z, builders);
        if (b) {
          state.audio?.play('thud1');
          if (!e.shiftKey) exitBuildMode();
        }
      }
      return;
    }

    if (input.abilityMode) {
      const hit = selectableAt(e);
      if (hit?.id) {
        const ok = sim().cmdAbility(sim().playerFaction, input.abilityMode, hit.id);
        if (ok) state.audio?.play('click');
      }
      input.abilityMode = null;
      document.body.classList.remove('targeting');
      return;
    }

    if (wasDrag) {
      // box select own units
      const x0 = Math.min(start.x, e.clientX), x1 = Math.max(start.x, e.clientX);
      const y0 = Math.min(start.y, e.clientY), y1 = Math.max(start.y, e.clientY);
      const ids = [];
      for (const u of sim().units) {
        if (u.dead || u.faction !== sim().playerFaction) continue;
        const s = world().project(u.x, 1, u.z);
        if (s && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) ids.push(u.id);
      }
      if (ids.length) setSelection(ids, e.shiftKey);
      else if (!e.shiftKey) setSelection([]);
      return;
    }

    // single click select
    const hit = selectableAt(e);
    if (hit?.id) {
      const ent = sim().getEntity(hit.id);
      if (ent && ent.faction === sim().playerFaction) { setSelection([hit.id], e.shiftKey); state.audio?.play('click', 0.4); return; }
      if (ent) { setSelection([hit.id]); return; } // inspect enemy/node
    }
    if (!e.shiftKey) setSelection([]);
  });

  // two-finger tap / right-click = command
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!world() || !sim()) return;
    if (input.buildMode) { exitBuildMode(); return; }
    if (input.abilityMode) { input.abilityMode = null; document.body.classList.remove('targeting'); return; }

    const mine = myUnits(state.selection);
    if (!mine.length) return;
    const hit = selectableAt(e);
    const p = hit?.ground || world().groundPoint(ndc(e).x, ndc(e).y);
    const targetId = hit?.id || null;
    const action = sim().smart(mine, p?.x ?? 0, p?.z ?? 0, targetId);
    const spot = targetId ? sim().getEntity(targetId) : p;
    if (spot) world().ping(spot.x, spot.z, action === 'attack' ? 0xff5040 : 0x9fe87a);
    state.audio?.play('click', 0.5);
  });

  // ---------- wheel: trackpad pan / pinch zoom ----------
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const w = world();
    if (!w) return;
    if (e.ctrlKey) {
      // pinch gesture (and ctrl+wheel)
      w.camDist *= Math.max(0.72, Math.min(1.38, 1 + e.deltaY * 0.012));
    } else if (e.deltaMode === 1 || (Math.abs(e.deltaY) > 90 && e.deltaX === 0 && Number.isInteger(e.deltaY))) {
      // classic mouse wheel -> zoom
      w.camDist *= 1 + Math.sign(e.deltaY) * 0.11;
    } else {
      // two-finger scroll -> pan in camera space
      const k = w.camDist * 0.0016;
      const sin = Math.sin(w.camYaw), cos = Math.cos(w.camYaw);
      w.camFocus.x += (e.deltaX * cos + e.deltaY * sin) * k;
      w.camFocus.z += (-e.deltaX * sin + e.deltaY * cos) * k;
    }
  }, { passive: false });

  // ---------- keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    input.keys.add(e.code);
    const w = world();
    switch (e.code) {
      case 'Escape':
        if (input.buildMode) exitBuildMode();
        else if (input.abilityMode) { input.abilityMode = null; document.body.classList.remove('targeting'); }
        else setSelection([]);
        break;
      case 'KeyH': state.hud?.toggleHelp(); break;
      case 'KeyP': state.paused = !state.paused; state.hud?.setPaused(state.paused); break;
      case 'KeyF':
        if (w) { const b = sim().fac(sim().playerFaction).base; w.camFocus.set(b.x, 0, b.z); }
        break;
      case 'Digit1': { // select all military
        const ids = sim().units.filter(u => !u.dead && u.faction === sim().playerFaction && UNITS[u.kind].dmg).map(u => u.id);
        setSelection(ids);
        break;
      }
      case 'Digit2': { // select all researchers
        const ids = sim().units.filter(u => !u.dead && u.faction === sim().playerFaction && u.kind === 'researcher').map(u => u.id);
        setSelection(ids);
        break;
      }
    }
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));

  function exitBuildMode() {
    input.buildMode = null;
    world().hideGhost();
    document.body.classList.remove('placing');
  }

  input.enterBuildMode = (kind) => {
    input.buildMode = kind;
    input.abilityMode = null;
    document.body.classList.add('placing');
  };
  input.enterAbilityMode = (key) => {
    input.abilityMode = key;
    input.buildMode = null;
    document.body.classList.add('targeting');
  };

  // ---------- per-frame camera keys ----------
  function update(dt) {
    const w = world();
    if (!w) return;
    const pan = w.camDist * 0.9 * dt;
    const sin = Math.sin(w.camYaw), cos = Math.cos(w.camYaw);
    const k = input.keys;
    let mx = 0, mz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) mz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) mz += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (mx || mz) {
      w.camFocus.x += (mx * cos + mz * sin) * pan;
      w.camFocus.z += (-mx * sin + mz * cos) * pan;
    }
    if (k.has('KeyQ')) w.camYaw += dt * 1.6;
    if (k.has('KeyE')) w.camYaw -= dt * 1.6;
    if (k.has('Equal') || k.has('NumpadAdd')) w.camDist *= 1 - dt * 1.2;
    if (k.has('Minus') || k.has('NumpadSubtract')) w.camDist *= 1 + dt * 1.2;
  }

  return input;
}
