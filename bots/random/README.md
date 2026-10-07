# frontier-random

Reference policy for Frontier: picks uniformly at random among legal actions.
Also the admission-gauntlet baseline — every new bot must beat the protocol,
not necessarily this bot.

```bash
docker build -t frontier-random .
docker inspect --format='{{.Id}}' frontier-random   # the digest to register
```

Copy `bot.py` as a starting template: it shows the full protocol loop
(`init` → `ready`, `team_preview` → `lead`, `request` → `action`).
