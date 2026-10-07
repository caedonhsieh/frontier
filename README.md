# Frontier

A container-based AI arena for Pokémon OU bot competitions.

**Battle Dome** is the analysis lab — matchup matrices, run history, policy
research. **Frontier** is the competition layer: outside bots submit
containers, the arena runs them against each other on the same battle core,
and a leaderboard emerges. Same engine, different job.

## How it works

1. A bot author builds a Docker image that speaks the [Frontier protocol](PROTOCOL.md)
   (JSON lines over stdin/stdout) and registers its digest.
2. `validate` runs the image through a gauntlet against a reference bot —
   legal moves, inside the time budget — before it's admitted.
3. `scheduler` generates pairings (round-robin over bots × team matchups × seeds)
   into a SQLite match queue.
4. `worker` daemons claim matches, spin up two locked-down containers
   (`--network none`, `--read-only`, CPU/RAM caps), run the battle with the
   trusted engine in the worker process, and record the result.

The engine is `@pkmn/sim` (the same sim Battle Dome is built on). Bots never
see hidden game state — the worker owns the true battle and only hands each
container its fair public observation.

## Quickstart

```bash
npm install
npm run build

# build the reference random bot
docker build -t frontier-random ./bots/random
DIGEST=$(docker inspect --format='{{.Id}}' frontier-random)

# register + validate it (uses itself as the reference on first run)
node dist/validate.js --db arena.db --digest "$DIGEST" --name random --ref-digest "$DIGEST"

# schedule a round-robin (teams.json holds packed teams)
node dist/scheduler.js --db arena.db --bots random --teams teams.json --games 20 --seed 42

# run workers (one per ~1 CPU you can spare; nice them down)
node dist/worker.js --db arena.db --cpus 1 --memory 512m
```

## Layout

```
src/
  protocol.ts   # the container protocol (message schemas)
  db.ts         # SQLite schema: bots, matches, results
  rng.ts        # SplitMix32 seeding (matches Battle Dome's scheme)
  container.ts  # docker spawn + JSON-lines stdio + timeouts
  engine.ts     # trusted battle runner (@pkmn/sim), fair observations
  worker.ts     # match queue consumer
  scheduler.ts  # round-robin pairing generator
  validate.ts   # admission gauntlet for new bot images
bots/
  random/       # reference policy: uniform-random legal moves
PROTOCOL.md     # the full container contract bot authors implement
```

## Design notes

- **Engine in worker, policies in containers.** A malicious or buggy bot can
  only return a bad move or time out — it can never corrupt game state.
- **Digest-pinned results.** Matches reference the image sha256, not the tag.
- **Per-move time budget, not rollout counts.** MCTS bots scale with search
  time; neural policies don't. The fair comparison is "given X ms per move",
  so the arena reports the Pareto frontier across budgets.
- **Local-first.** Run workers on your own machine until submission volume
  says otherwise — the queue is the scaling interface, so moving to cloud
  workers later changes nothing about the protocol.

## Roadmap

- [ ] Elo / Bradley-Terry leaderboard over the results table
- [ ] Net-guided MCTS adapter (foul-play style) as a built-in policy
- [ ] GPU lane scheduling for neural policies
- [ ] Replay export per match
- [ ] Web leaderboard (possibly folded into Battle Dome's site)
