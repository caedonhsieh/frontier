#!/usr/bin/env python3
"""Frontier adapter for foul play (MCTS over poke-engine).

Drives foul play headlessly, exactly as it runs on Showdown:
  - the arena's public protocol lines feed fp.battle.protocol.update_battle
    (the same parser the websocket client uses),
  - the arena's observation is delivered as a synthesized |request| line,
  - decisions come from fp.search.main.find_best_move (MCTS) and are mapped
    back to Frontier actions.

No network, no websocket, no Showdown server. One match per process.
"""
import json
import logging
import random
import sys
from copy import deepcopy

from fp import constants
from fp.battle.protocol import update_battle
from fp.battle.state import Battle, LastUsedMove, Pokemon
from fp.config import FoulPlayConfig
from fp.format_spec import FormatSpec
from fp.modes.base import format_decision
from fp.modes.standard_battle import StandardBattleMode
from fp.search.main import find_best_move

log = logging.getLogger("frontier-foulplay")

FORMAT = "gen9ou"
# Per-decision MCTS budget: the search runs up to 2 sequential battles
# (team preview / unknown opponent moves), so each gets half the clock
# minus a reserve for process-spawn and state-building overhead.
OVERHEAD_MS = 1500


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def normalize(name):
    return "".join(c for c in name.lower() if c.isalnum())


class FoulPlayAdapter:
    def __init__(self):
        self.battle = None
        self.slot = "p1"
        self.move_time_ms = 5000
        self.mode = StandardBattleMode()
        FoulPlayConfig.pokemon_format = FORMAT
        FoulPlayConfig.username = "frontier"
        FoulPlayConfig.parallelism = 1
        FoulPlayConfig.search_threads = 1

    # ------------------------------------------------------------------
    # protocol handlers
    # ------------------------------------------------------------------
    def on_init(self, msg):
        self.slot = "p2" if msg.get("slot") == "p2" else "p1"
        self.move_time_ms = int(msg.get("move_time_ms", 5000))
        random.seed(msg.get("seed", 0))
        send({"type": "ready"})

    def on_team_preview(self, msg):
        me = "p1" if self.slot == "p1" else "p2"
        op = "p2" if self.slot == "p1" else "p1"

        b = Battle("frontier")
        b.pokemon_format = FORMAT
        b.generation = FormatSpec.from_format_string(FORMAT).generation
        b.mode = self.mode
        b.user.name = me
        b.opponent.name = op

        # Own team from the sim's full side data (first mon marked active,
        # exactly as the sim reports it at preview).
        req_json = {"side": msg["own_team_full"], "rqid": 1, "teamPreview": True}
        b.user.initialize_first_turn_user_from_json(req_json)
        b.request_json = req_json

        # Opponent preview: species names only (public info).
        opp_species = [m["name"] for m in msg["opp_team"]]
        b.initialize_team_preview(opp_species, FORMAT)
        # NOTE: battle.team_preview stays False on the main battle object,
        # exactly as in foul play's own flow (only the lead-pick copy below
        # gets team_preview=True, mirroring handle_team_preview).

        # Opponent-set datasets (usage stats + team dumps), cached on disk
        # at image build time — no network at runtime.
        spec = FormatSpec.from_format_string(FORMAT)
        names = {p.name for p in b.user.reserve} | {
            p.name for p in b.opponent.reserve
        }
        self.mode.smogon_sets.initialize(spec, names)
        self.mode.team_datasets.initialize(spec, names)

        # MCTS lead pick, mirroring handle_team_preview in fp/modes/base.py.
        try:
            bc = deepcopy(b)
            bc.user.active = Pokemon.get_dummy()
            bc.opponent.active = Pokemon.get_dummy()
            bc.team_preview = True
            decision = self.search(bc)
            lead_idx = self.parse_lead_index(decision, b)
        except Exception as e:
            log.warning("team preview search failed: %s", e)
            lead_idx = 0

        order = [lead_idx] + [i for i in range(6) if i != lead_idx]
        send({"type": "lead", "order": order})
        self.battle = b

    def on_request(self, msg):
        b = self.battle
        obs = msg["observation"]
        try:
            public_log = msg.get("public_log") or []
            if public_log:
                update_battle(b, "\n".join(public_log))
            action_required = update_battle(b, "|request|" + json.dumps(obs))
            if not action_required or b.wait:
                return send(
                    {"type": "action", "action": self.fallback_action(obs)}
                )

            # Replicates async_pick_move (fp/modes/base.py), synchronously.
            battle_copy = deepcopy(b)
            battle_copy.user.update_from_request_json(battle_copy.request_json)
            best_move = self.search(battle_copy)
            decision = format_decision(battle_copy, best_move)
            b.user.last_selected_move = LastUsedMove(
                b.user.active.name,
                best_move.removesuffix("-tera").removesuffix("-mega"),
                b.turn,
            )
            action = self.to_frontier_action(decision[0], obs)
        except Exception as e:
            log.warning("decision failed, falling back: %s", e)
            action = self.fallback_action(obs)
        send({"type": "action", "action": action})

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------
    def search(self, battle):
        """Run MCTS with a budget derived from the arena's per-move clock."""
        FoulPlayConfig.search_time_ms = max(
            200, (self.move_time_ms - OVERHEAD_MS) // 2
        )
        return find_best_move(battle)

    def parse_lead_index(self, decision, battle):
        """Map foul play's lead decision to a 0-indexed team position."""
        # decision looks like "switch gliscor"
        if decision.startswith(constants.SWITCH_STRING + " "):
            name = decision.split("switch ", 1)[-1]
            for p in battle.user.reserve:
                if p is not None and normalize(p.name) == normalize(name):
                    return p.index - 1
        return 0

    def to_frontier_action(self, decision_msg, obs):
        """Map '/switch N' or '/choose move NAME [terastallize]' to a
        Frontier action string."""
        parts = decision_msg.split()
        if not parts:
            return self.fallback_action(obs)
        if parts[0] == "/switch" and len(parts) >= 2 and parts[1].isdigit():
            return "switch {}".format(parts[1])
        if parts[0] == "/choose" and len(parts) >= 3 and parts[1] == "move":
            tera = parts[-1] == constants.TERASTALLIZE
            name = " ".join(parts[2:-1] if tera else parts[2:])
            idx = self.move_index(name, obs)
            if idx is not None:
                return "move {}{}".format(idx + 1, " tera" if tera else "")
        return self.fallback_action(obs)

    def move_index(self, name, obs):
        """Find the move slot index by normalized name."""
        want = normalize(name)
        moves = ((obs.get("active") or [{}])[0].get("moves") or [])
        for i, m in enumerate(moves):
            if normalize(m.get("id", "")) == want or normalize(
                m.get("move", "")
            ) == want:
                return i
        return None

    def fallback_action(self, obs):
        """Uniform-random legal move. Guarantees protocol compliance."""
        choices = []
        active = (obs.get("active") or [{}])[0]
        for i, m in enumerate(active.get("moves") or []):
            if m.get("disabled") or m.get("pp", 1) <= 0:
                continue
            choices.append("move {}".format(i + 1))
        for i, p in enumerate((obs.get("side") or {}).get("pokemon") or []):
            if p.get("active") or p.get("condition") == "0 fnt":
                continue
            choices.append("switch {}".format(i + 1))
        return random.choice(choices) if choices else "pass"


def main():
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    adapter = FoulPlayAdapter()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = msg.get("type")
        try:
            if t == "init":
                adapter.on_init(msg)
            elif t == "team_preview":
                adapter.on_team_preview(msg)
            elif t == "request":
                adapter.on_request(msg)
            elif t == "battle_end":
                return
        except Exception as e:
            log.error("fatal error on %s: %s", t, e)
            # Stay protocol-compliant: answer something legal.
            if t == "team_preview":
                send({"type": "lead", "order": [0, 1, 2, 3, 4, 5]})
            elif t == "request":
                send(
                    {
                        "type": "action",
                        "action": adapter.fallback_action(msg.get("observation", {})),
                    }
                )


if __name__ == "__main__":
    main()
