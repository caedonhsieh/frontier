# Frontier Container Protocol v1

Bots are Docker images. The arena launches one container per bot per match
and talks to it over **stdin/stdout, one JSON object per line**.
No network, read-only filesystem, hard CPU/RAM caps, killed when the match ends.

Environment variables provided: `FRONTIER_MATCH_ID`, `FRONTIER_SLOT` (`p1`/`p2`).

## Worker → bot

### `init`

```json
{
  "type": "init",
  "match_id": "m_abc123",
  "slot": "p1",
  "format": "gen9ou",
  "team_size": 6,
  "move_time_ms": 5000,
  "seed": 123456789
}
```

Sent once at startup. `seed` is for the bot's own RNG — it is *not* the
battle seed and reveals nothing about RNG outcomes.

### `team_preview`

```json
{
  "type": "team_preview",
  "own_team": [{"name": "Great Tusk", "types": ["Fighting", "Ground"], "hp": 100, "maxhp": 100}],
  "opp_team": [{"name": "Gholdengo", "types": ["Steel", "Ghost"], "hp": 100, "maxhp": 100}]
}
```

Both teams as revealed at preview: species, types, HP. No movesets, abilities,
or items for the opponent — exactly what a human sees. Your own team is listed
in the order you'll reference in your reply.

### `request`

```json
{
  "type": "request",
  "turn": 12,
  "observation": { "...": "your side's public battle state" },
  "time_ms": 5000
}
```

`observation` is your side's request object from the sim: your active Pokémon
(moves, PP, disabled flags, trapping), your full bench, and the opponent's
*active* Pokémon as publicly visible. Hidden opponent information is never
included. Reply within `time_ms` or the move is forfeited to a default.

### `battle_end`

```json
{ "type": "battle_end", "winner": "p1" }
```

`winner` is `null` on a draw.

## Bot → worker

Reply to `init` with exactly:

```json
{ "type": "ready" }
```

Reply to `team_preview` with lead order as 0-indexed positions:

```json
{ "type": "lead", "order": [2, 0, 1, 3, 4, 5] }
```

Reply to `request` with a Showdown choice string:

```json
{ "type": "action", "action": "move 2" }
```

Legal actions: `move 1`–`move 4` (append ` tera` to terastallize, e.g.
`move 1 tera`), `switch 2`–`switch 6`, `pass`. Anything else — or a move the
sim rejects — counts as an illegal move and is replaced by a default choice.
Three strikes (timeouts + illegal moves) forfeits the match.

## Rules for bot authors

1. **Flush stdout after every line.** Buffered output reads as a timeout.
   (Python: run with `-u` or flush explicitly.)
2. **One line in, one line out.** Never emit unsolicited lines; the worker
   pairs each reply to the most recent message.
3. **Stay in your budget.** `move_time_ms` is a hard cap. MCTS bots: tune
   rollouts to finish comfortably inside it.
4. **No hidden-state assumptions.** You only ever see the public observation.
   Anything else is a bug in the arena — report it, don't exploit it.
5. **Determinism is your friend.** Seeded RNG makes your losses debuggable.
