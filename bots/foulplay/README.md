# frontier-foulplay

Frontier container for [foul play](https://github.com/pmariglia/foul-play)
(pinned @ `8f541f8`) — Monte Carlo Tree Search over the Rust `poke-engine`,
driven headlessly.

- `adapter.py` — Frontier protocol glue. Feeds the arena's public protocol
  lines into foul play's own `update_battle` parser (the exact code path the
  websocket client uses), delivers observations as synthesized `|request|`
  lines, and maps MCTS decisions back to Frontier actions. No network, no
  Showdown server.
- `warmup.py` — pre-warms the Smogon usage-stats and team-dataset caches at
  image build time (the arena runs containers with `--network none`).

```bash
docker build -t frontier-foulplay .
docker inspect --format='{{.Id}}' frontier-foulplay   # digest to register
```

Search budget: the arena's per-move clock minus 1.5s overhead, split across
foul play's (up to 2) sequential MCTS battles — `parallelism=1`,
`search_threads=1` to fit the container's single CPU.

Notes:
- The usage-stats snapshot is baked at build time (deterministic opponent
  modeling); rebuild the image to refresh it.
- Team preview lead is chosen by MCTS, mirroring foul play's
  `handle_team_preview`; remaining order follows team order.
