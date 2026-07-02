// WebAudio: real SFX driven by sim events + quiet music bed.
// Throttled per event type; volume falls off with distance from camera focus.
const FILES = {
  blaster: 'assets/audio/sfx/blaster.mp3',
  lazer: 'assets/audio/sfx/lazer.wav',
  explosion: 'assets/audio/sfx/explosion.mp3',
  cannon: 'assets/audio/sfx/cannon.mp3',
  death: 'assets/audio/sfx/death.wav',
  squit: 'assets/audio/sfx/squit.wav',
  pickup: 'assets/audio/sfx/pickup.wav',
  click: 'assets/audio/sfx/click.wav',
  coin: 'assets/audio/sfx/coin.ogg',
  thud1: 'assets/audio/sfx/thud1.ogg',
  thud2: 'assets/audio/sfx/thud2.ogg',
  fall: 'assets/audio/sfx/fall.ogg',
  pong: 'assets/audio/sfx/pong.mp3',
  theme: 'assets/audio/music/theme.mp3',
  ambience: 'assets/audio/music/ambience.ogg',
};

export async function initAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const sfxBus = ctx.createGain(); sfxBus.connect(master);
  const musicBus = ctx.createGain(); musicBus.gain.value = 0.14; musicBus.connect(master);

  const buffers = {};
  await Promise.all(Object.entries(FILES).map(async ([k, url]) => {
    try {
      const ab = await (await fetch(url)).arrayBuffer();
      buffers[k] = await ctx.decodeAudioData(ab);
    } catch (e) { console.warn('audio load failed', k, e); }
  }));

  const lastPlay = {};
  function play(name, vol = 1, rate = 1) {
    const buf = buffers[name];
    if (!buf || ctx.state !== 'running') return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(sfxBus);
    src.start();
  }

  function throttled(type, minGap, fn) {
    const now = ctx.currentTime;
    if (now - (lastPlay[type] || -9) < minGap) return;
    lastPlay[type] = now;
    fn();
  }

  let musicStarted = false;
  function startMusic() {
    if (musicStarted || !buffers.theme) return;
    musicStarted = true;
    for (const [name, vol] of [['theme', 1], ['ambience', 0.8]]) {
      if (!buffers[name]) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffers[name];
      src.loop = true;
      const g = ctx.createGain(); g.gain.value = vol;
      src.connect(g); g.connect(musicBus);
      src.start();
    }
  }

  // resume on first user gesture (autoplay policy)
  const resume = () => {
    ctx.resume().then(startMusic);
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
  };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
  if (ctx.state === 'running') startMusic();

  function dvol(e, state, base) {
    const w = state?.world;
    const x = e.x ?? e.to?.x, z = e.z ?? e.to?.z;
    if (!w || x === undefined) return base;
    const d = Math.hypot(w.camFocus.x - x, w.camFocus.z - z);
    return base * Math.max(0.06, 1 - d / 95);
  }

  function applyEvents(events, state) {
    for (const e of events) {
      const mine = e.fid === state?.sim?.playerFaction;
      switch (e.type) {
        case 'shot': throttled('shot', 0.08, () => play('blaster', dvol(e, state, 0.35))); break;
        case 'punch': throttled('punch', 0.11, () => play('thud2', dvol(e, state, 0.8), 1.25)); break;
        case 'zap': throttled('zap', 0.13, () => play('lazer', dvol(e, state, 0.4))); break;
        case 'unitDied': throttled('death', 0.18, () => play('death', dvol(e, state, 0.5))); break;
        case 'buildingDied':
          play('explosion', dvol(e, state, 0.9));
          throttled('cannon', 0.4, () => play('cannon', dvol(e, state, 0.5)));
          break;
        case 'buildTick': throttled('build', 0.5, () => play('thud1', dvol(e, state, 0.28), 1.3)); break;
        case 'built': if (mine) play('coin', 0.5); break;
        case 'trained': if (mine) play('pong', 0.5); break;
        case 'placed': if (mine) play('thud1', 0.7); break;
        case 'milestone': play('pickup', mine ? 0.9 : 0.45, mine ? 1 : 1.2); break;
        case 'finalrun': play('cannon', 0.7, 0.7); play('pickup', 0.8, 0.8); break;
        case 'underattack': if (mine) throttled('alarm', 4, () => play('fall', 0.9, 0.7)); break;
        case 'poached': play('squit', mine || e.victim === state?.sim?.playerFaction ? 0.8 : 0.3); break;
        case 'probed': if (e.victim === state?.sim?.playerFaction) play('fall', 0.8); break;
        case 'nodeDepleted': throttled('dry', 1, () => play('fall', 0.35, 1.4)); break;
        case 'eliminated': play('explosion', 0.8, 0.7); play('cannon', 0.6, 0.6); break;
        case 'victory':
          play('pickup', 1); setTimeout(() => play('coin', 0.9), 250); setTimeout(() => play('pickup', 0.9, 1.3), 500);
          break;
      }
    }
  }

  return { ctx, play, applyEvents, startMusic, buses: { master, sfxBus, musicBus } };
}
