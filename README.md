# SUPERINTELLIGENCE — an RTS about the AI race

A browser-based, bird's-eye real-time strategy game where **OpenAI, Anthropic,
Google DeepMind and xAI** race to be first to superintelligence. Age of
Empires bones, but every mechanic is drawn from what frontier labs actually
compete over: **compute, data, talent, government favor and public trust**.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. Plain ES modules + Three.js from `lib/`.

## The metaphor, made mechanical

| RTS concept | In this game |
|---|---|
| Gold mine | **Datastream nodes** — researchers scrape them; they run dry mid-game, forcing a fight for the center or a pivot to Synthetic Data Plants |
| Town center | **Frontier Lab** — trains researchers, runs milestone research; lose it and your lab folds |
| Economy | **Compute** from Compute Clusters, **Data** from nodes, **Talent** cap from Campuses, **Favor** from the Policy Office |
| Tech tree | **5 frontier milestones**: Foundation Model → Reasoning → Autonomous Agents → Recursive Self-Improvement → **SUPERINTELLIGENCE** |
| Win condition | First lab to finish the final training run wins — everyone is warned when it starts, and damaging their HQ pauses it |
| Army | **Agents** (melee cyber-raiders) and **Sentinels** (ranged security), countered by **Firewall Towers** |
| Diplomacy screen | **Trust** (public perception): high trust speeds research, low trust brings regulatory fines. Poaching, probes and raids all cost trust |
| Spells | **Poach Talent** (steal a rival researcher), **Regulatory Probe** (halve a rival's compute), **State Subsidy**, **PR Campaign** |

Each faction plays to its reputation: OpenAI *Blitzscale* (+compute, faster
research, eroding trust), Anthropic *Constitutional* (trust floor + high-trust
research bonus), DeepMind *TPU Empire* (cheap buildings, richer nodes), xAI
*Ship It* (fast training, harder-hitting agents, bleeding trust).

The three rival labs are driven by utility AIs with personality weights —
they expand, tech, defend, raid the race leader, poach your researchers and
call the regulators on whoever's winning.

## Controls (trackpad-first)

- **Two-finger scroll** — pan · **pinch** — zoom · **Q/E** — rotate
- **Click / drag** — select · **two-finger tap** (right-click) — contextual order
- **1 / 2** — select army / researchers · **F** — jump to base · **H** — in-game guide · **P** — pause

## Architecture

- `src/sim/` — pure fixed-timestep simulation (no rendering imports); testable headless: `node tools/simtest.mjs 30 7`
- `src/render/` — Three.js world that mirrors sim state; skeletal animation, dramatic lighting, shadows, effects; auto quality scaling
- `src/ui/` — overlay HUD, race panel, minimap, guide, menus
- `src/input.js` / `src/audio.js` — trackpad-first controls; WebAudio SFX driven by sim events

All 3D models, sound effects and music are real, downloaded, CC-licensed
assets — see [ATTRIBUTION.md](ATTRIBUTION.md).
