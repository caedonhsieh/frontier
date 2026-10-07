/**
 * SQLite store: bot registry + match queue + results.
 * Uses node:sqlite (built into Node 22+), no extra dependencies.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type BotStatus = 'pending' | 'active' | 'rejected';
export type MatchStatus = 'queued' | 'running' | 'done' | 'failed';

export interface BotRow {
  id: string;
  name: string;
  version: string;
  digest: string;
  status: BotStatus;
  created_at: string;
}

export interface MatchRow {
  id: string;
  bot_a: string;
  bot_b: string;
  team_a: string; // packed team for p1
  team_b: string; // packed team for p2
  seed: number;
  move_time_ms: number;
  status: MatchStatus;
  result_json: string | null;
  created_at: string;
}

export function openDb(path = 'arena.db'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1',
      digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS matches(
      id TEXT PRIMARY KEY,
      bot_a TEXT NOT NULL REFERENCES bots(id),
      bot_b TEXT NOT NULL REFERENCES bots(id),
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      seed INTEGER NOT NULL,
      move_time_ms INTEGER NOT NULL DEFAULT 5000,
      status TEXT NOT NULL DEFAULT 'queued',
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
  `);
  return db;
}

export function registerBot(
  db: DatabaseSync,
  bot: { id: string; name: string; version?: string; digest: string }
): void {
  db.prepare(
    `INSERT INTO bots(id, name, version, digest, status)
     VALUES(?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version,
       digest=excluded.digest, status='pending'`
  ).run(bot.id, bot.name, bot.version ?? '1', bot.digest);
}

export function setBotStatus(db: DatabaseSync, id: string, status: BotStatus): void {
  db.prepare(`UPDATE bots SET status=? WHERE id=?`).run(status, id);
}

export function getBot(db: DatabaseSync, id: string): BotRow | undefined {
  return db.prepare(`SELECT * FROM bots WHERE id=?`).get(id) as BotRow | undefined;
}

export function queueMatch(
  db: DatabaseSync,
  m: { bot_a: string; bot_b: string; team_a: string; team_b: string; seed: number; move_time_ms?: number }
): string {
  const id = `m_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO matches(id, bot_a, bot_b, team_a, team_b, seed, move_time_ms)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(id, m.bot_a, m.bot_b, m.team_a, m.team_b, m.seed, m.move_time_ms ?? 5000);
  return id;
}

/** Atomically claim one queued match. The single UPDATE is the whole
 *  concurrency story — safe across any number of worker processes. */
export function claimMatch(db: DatabaseSync): MatchRow | undefined {
  return db.prepare(
    `UPDATE matches SET status='running'
     WHERE id = (SELECT id FROM matches WHERE status='queued' ORDER BY created_at LIMIT 1)
     RETURNING *`
  ).get() as MatchRow | undefined;
}

export function finishMatch(db: DatabaseSync, id: string, result: unknown): void {
  db.prepare(`UPDATE matches SET status='done', result_json=? WHERE id=?`)
    .run(JSON.stringify(result), id);
}

export function failMatch(db: DatabaseSync, id: string, reason: string): void {
  db.prepare(`UPDATE matches SET status='failed', result_json=? WHERE id=?`)
    .run(JSON.stringify({ error: reason }), id);
}

export function queueDepth(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM matches WHERE status='queued'`).get() as { n: number }).n;
}
