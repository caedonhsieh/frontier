#!/usr/bin/env node
/**
 * Frontier scheduler: generate round-robin pairings into the match queue.
 *
 *   node dist/scheduler.js --db arena.db --bots random,heuristic \
 *     --teams teams.json --games 50 --seed 42 --move-time-ms 5000
 *
 * teams.json: JSON array of packed team strings.
 * Every bot pair plays every ordered team pairing (A vs B and B vs A),
 * `games` battles each, with seeds drawn from a SplitMix32 stream.
 */
import { readFileSync } from 'node:fs';
import { openDb, queueMatch, getBot } from './db.js';
import { splitmix32 } from './rng.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const db = openDb(arg('db') ?? 'arena.db');
  const bots = (arg('bots') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (bots.length === 0) {
    console.error('no bots: pass --bots id1,id2,...');
    process.exit(1);
  }
  for (const id of bots) {
    const b = getBot(db, id);
    if (!b) {
      console.error(`bot not registered: ${id}`);
      process.exit(1);
    }
    if (b.status !== 'active') {
      console.error(`bot not active (status=${b.status}): ${id} — run validate first`);
      process.exit(1);
    }
  }

  const teamsPath = arg('teams');
  if (!teamsPath) {
    console.error('missing --teams teams.json');
    process.exit(1);
  }
  const teams = JSON.parse(readFileSync(teamsPath, 'utf8')) as string[];
  if (!Array.isArray(teams) || teams.length === 0) {
    console.error('teams.json must be a non-empty JSON array of packed teams');
    process.exit(1);
  }

  const games = parseInt(arg('games') ?? '20', 10);
  const moveTimeMs = parseInt(arg('move-time-ms') ?? '5000', 10);
  const rng = splitmix32(parseInt(arg('seed') ?? '1', 10));
  const nextSeed = () => Math.floor(rng() * 0x100000000);

  let queued = 0;
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      for (let ta = 0; ta < teams.length; ta++) {
        for (let tb = 0; tb < teams.length; tb++) {
          if (ta === tb) continue;
          // both team assignments so neither bot is favored by a team
          for (const [a, b, tea, teb] of [
            [bots[i], bots[j], teams[ta], teams[tb]],
            [bots[j], bots[i], teams[tb], teams[ta]],
          ] as const) {
            for (let g = 0; g < games; g++) {
              queueMatch(db, {
                bot_a: a,
                bot_b: b,
                team_a: tea,
                team_b: teb,
                seed: nextSeed(),
                move_time_ms: moveTimeMs,
              });
              queued++;
            }
          }
        }
      }
    }
  }
  console.log(`queued ${queued} matches (${bots.length} bots, ${teams.length} teams, ${games} games each)`);
}

main();
