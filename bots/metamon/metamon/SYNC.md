# Vendored from battle-dome

These modules are copied from `battle-dome/src/sim/metamon/` (the Metamon
Kadabra3 pilot: battle tracker, observation pipeline, pilot).

Source of truth: the battle-dome repo. If the pilot changes there, re-copy:
```bash
cp ~/workspace/battle-dome/src/sim/metamon/*.ts metamon/
cp ~/workspace/battle-dome/src/sim/metamon/data/* metamon/data/
```
Do NOT edit the vendored files in place except to fix Frontier-specific
issues — and upstream those fixes to battle-dome.
