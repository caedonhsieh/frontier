#!/usr/bin/env node
/**
 * Frontier worker: claim queued matches and run them.
 *
 *   node dist/worker.js --db arena.db --cpus 1 --memory 512m [--gpu] [--once]
 *
 * Run one worker per CPU you can spare. Nice them down so match bursts
 * don't stutter the machine: `nice -n 10 node dist/worker.js ...`
 */
import { openDb, claimMatch, finishMatch, failMatch, getBot, queueDepth } from './db.js';
import { runMatch } from './engine.js';
import type { ContainerOpts } from './container.js';

const MATCH_TIMEOUT_MS = 15 * 60 * 1000; // hard backstop per match

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dbPath = arg('db') ?? 'arena.db';
  const db = openDb(dbPath);
  const container: ContainerOpts = {
    cpus: arg('cpus') ?? '1',
    memory: arg('memory') ?? '512m',
    gpu: flag('gpu'),
  };
  console.log(`worker up (db=${dbPath}, cpus=${container.cpus}, mem=${container.memory}${container.gpu ? ', gpu' : ''})`);

  for (;;) {
    const m = claimMatch(db);
    if (!m) {
      if (flag('once')) break;
      await sleep(5000);
      continue;
    }
    const botA = getBot(db, m.bot_a);
    const botB = getBot(db, m.bot_b);
    console.log(
      `[${new Date().toISOString()}] ${m.id}: ${m.bot_a} vs ${m.bot_b} (depth=${queueDepth(db)})`
    );
    if (!botA || !botB) {
      failMatch(db, m.id, `unknown bot in registry: ${!botA ? m.bot_a : m.bot_b}`);
      continue;
    }
    try {
      const result = await Promise.race([
        runMatch({
          matchId: m.id,
          botA: { id: botA.id, digest: botA.digest },
          botB: { id: botB.id, digest: botB.digest },
          teamA: m.team_a,
          teamB: m.team_b,
          seed: m.seed,
          moveTimeMs: m.move_time_ms,
          container,
        }),
        sleep(MATCH_TIMEOUT_MS).then(() => {
          throw new Error(`match exceeded ${MATCH_TIMEOUT_MS / 60000}min backstop`);
        }),
      ]);
      finishMatch(db, m.id, result);
      console.log(
        `  -> ${result.winner_bot ?? 'draw'} wins in ${result.turns} turns` +
          (result.forfeit ? ` (forfeit by ${result.forfeit})` : '')
      );
    } catch (e) {
      failMatch(db, m.id, String(e));
      console.error(`  -> failed: ${e}`);
    }
    if (flag('once')) break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
