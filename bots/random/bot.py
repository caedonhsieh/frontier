#!/usr/bin/env python3
"""Frontier reference bot: uniform-random over legal actions.

Implements the Frontier container protocol v1 (see PROTOCOL.md).
Used as the admission-gauntlet baseline and as a template for bot authors.
"""
import sys
import json
import random


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def legal_choices(obs):
    """Derive legal Showdown choices from the public observation."""
    choices = []
    active = (obs.get("active") or [{}])[0]
    for i, m in enumerate(active.get("moves") or []):
        if m.get("disabled") or m.get("pp", 1) <= 0:
            continue
        choices.append(f"move {i + 1}")
    for i, p in enumerate((obs.get("side") or {}).get("pokemon") or []):
        if p.get("active"):
            continue
        if p.get("condition") == "0 fnt":
            continue
        choices.append(f"switch {i + 1}")
    return choices or ["pass"]


def main():
    data = sys.stdin
    for line in data:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = msg.get("type")
        if t == "init":
            random.seed(msg.get("seed", 0))
            send({"type": "ready"})
        elif t == "team_preview":
            n = len(msg["own_team"])
            order = list(range(n))
            random.shuffle(order)
            send({"type": "lead", "order": order})
        elif t == "request":
            send({"type": "action", "action": random.choice(legal_choices(msg["observation"]))})
        elif t == "battle_end":
            return


if __name__ == "__main__":
    main()
