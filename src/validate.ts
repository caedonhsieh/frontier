#!/usr/bin/env node
/**
 * Frontier admission gauntlet for a new bot image.
 *
 *   node dist/validate.js --db arena.db --digest <sha256:...> --name foulplay \
 *     [--version 1] [--games 20] [--ref-digest <sha256:...>] [--team <packed>]
 *
 * Registers the bot as pending, runs `games` battles against a reference bot
 * (default: itself, i.e. a mirror self-play sanity check), and promotes it to
 * active only if it speaks the protocol cleanly: legal moves, inside the time
 * budget, no forfeits.
 */
import { openDb, registerBot, setBotStatus } from './db.js';
import { runMatch, type MatchResult } from './engine.js';
import { splitmix32 } from './rng.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// A minimal legal gen9ou team (packed). Replace with a real team via --team.
const DEFAULT_TEAM =
  'Great Tusk||leftovers|1|protosynthesis|headlongrush,rapidspin,icespinner,stealthrock|Jolly|,,,,,|||,,,|';

async function main(): Promise<void> {
  const db = openDb(arg('db') ?? 'arena.db');
  const digest = arg('digest');
  const name = arg('name') ?? `bot_${Date.now().toString(36)}`;
  if (!digest) {
    console.error('missing --digest (use `docker inspect --format="{{.Id}}"` to get it)');
    process.exit(1);
  }
  const refDigest = arg('ref-digest') ?? digest;
  const games = parseInt(arg('games') ?? '20', 10);
  const team = arg('team') ?? DEFAULT_TEAM;
  const moveTimeMs = 5000;
  const rng = splitmix32(parseInt(arg('seed') ?? '7', 10));

  const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  registerBot(db, { id, name, version: arg('version') ?? '1', digest });
  console.log(`validating ${name} (${digest.slice(0, 19)}…) over ${games} games…`);

  let completed = 0;
  let wins = 0;
  let forfeits = 0;
  const results: MatchResult[] = [];
  for (let g = 0; g < games; g++) {
    const seed = Math.floor(rng() * 0x100000000);
    const matchId = `v_${id}_${g}`;
    try {
      const r = await runMatch({
        matchId,
        botA: { id, digest },
        botB: { id: `${id}_ref`, digest: refDigest },
        teamA: team,
        teamB: team,
        seed,
        moveTimeMs,
        container: { cpus: '1', memory: '512m' },
      });
      results.push(r);
      completed++;
      if (r.winner_bot === id) wins++;
      if (r.forfeit === 'p1') forfeits++;
      process.stdout.write(r.forfeit === 'p1' ? 'F' : r.winner_bot === id ? 'W' : '.');
    } catch (e) {
      process.stdout.write('E');
      console.error(`\n  game ${g} errored: ${e}`);
    }
  }
  console.log('');

  const avgTimeouts =
    results.reduce((a, r) => a + r.timeouts.p1, 0) / Math.max(1, results.length);
  const avgIllegal =
    results.reduce((a, r) => a + r.illegal.p1, 0) / Math.max(1, results.length);
  const pass = completed >= games * 0.9 && forfeits === 0 && avgTimeouts <= 1 && avgIllegal <= 1;

  console.log(
    `completed ${completed}/${games}, wins ${wins}, forfeits ${forfeits}, ` +
      `avg timeouts/game ${avgTimeouts.toFixed(2)}, avg illegal/game ${avgIllegal.toFixed(2)}`
  );
  setBotStatus(db, id, pass ? 'active' : 'rejected');
  console.log(pass ? `✓ ${id} admitted as active` : `✗ ${id} rejected — check protocol compliance`);
  if (!pass) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
