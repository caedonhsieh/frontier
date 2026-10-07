# frontier-metamon

Frontier container for the Metamon Kadabra3 neural policy (the pilot from
Battle Dome's `metamon-kadabra3` runs).

- `src/adapter.ts` — Frontier protocol glue (the only Frontier-specific code).
- `metamon/` — vendored pilot from battle-dome (`src/sim/metamon/`): battle
  tracker, observation pipeline, KV-cache inference. See `metamon/SYNC.md`
  before editing; battle-dome is the source of truth.
- Model: `kadabra3_kv_fp16_b2_noeinsum.onnx` (~94MB fp16), downloaded from
  the battle-dome site at image build time, run via onnxruntime-node on CPU
  (~0.1s per batched inference step).

```bash
docker build -t frontier-metamon .
docker inspect --format='{{.Id}}' frontier-metamon   # digest to register
```

Behavior matches battle-dome exactly: argmax over legal actions, fixed
1-6 lead order at team preview, per-side KV caches.
