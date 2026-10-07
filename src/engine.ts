/**
 * Trusted battle runner. The worker owns the true game state (@pkmn/sim);
 * bot containers only ever receive their fair public observation.
 *
 * Fairness-critical: the opponent's hidden information (sets, unrevealed
 * details) is NEVER serialized into a message. See buildPreview() below.
 *
 * Bots that maintain state across turns (Metamon's tracker, foul play's
 * protocol parser) get the public battle log: the sim's protocol lines with
 * |split| sections resolved per side, exactly as a Showdown client would see.
 */
import { Battle, toID } from '@pkmn/sim';
import { BotConnection, type ContainerOpts } from './container.js';
import type { PreviewMon, Slot } from './protocol.js';
import { simSeed } from './rng.js';

export interface MatchConfig {
  matchId: string;
  botA: { id: string; digest: string };
  botB: { id: string; digest: string };
  teamA: string; // packed team for p1
  teamB: string; // packed team for p2
  seed: number;
  moveTimeMs: number;
  maxTurns?: number;
  container: ContainerOpts;
}

export interface MatchResult {
  match_id: string;
  bot_a: string;
  bot_b: string;
  winner: Slot | null; // null = draw
  winner_bot: string | null;
  forfeit: Slot | null;
  turns: number;
  timeouts: Record<Slot, number>;
  illegal: Record<Slot, number>;
  avg_move_ms: Record<Slot, number>;
  seed: number;
}

const MAX_STRIKES = 3; // timeouts + illegal moves before a forfeit

/** Side names must not contain protocol separators. */
function safeName(id: string): string {
  return id.replace(/[|\n\r]/g, '_').slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* protocol line capture (ported from battle-dome's parity driver)     */
/* ------------------------------------------------------------------ */

interface CaptureState {
  lines: string[];
}

/** Capture the sim's broadcast protocol lines. Requests travel via
 *  sideupdate, not update, so |request| lines never land here. */
function makeCapture() {
  const state: CaptureState = { lines: [] };
  const send = (type: string, data: string | string[]) => {
    if (type !== 'update') return;
    const txt = Array.isArray(data) ? data.join('\n') : data;
    for (const line of txt.split('\n')) {
      if (line) state.lines.push(line);
    }
  };
  return { state, send };
}

/**
 * Fresh lines for one side's view, with |split| sections resolved the way a
 * real client sees them (|split|p1 is followed by the p1-only line, then the
 * p2-only line).
 */
function takeNewLines(
  state: CaptureState,
  side: Slot,
  consumed: Record<Slot, number>
): string[] {
  const fresh = state.lines.slice(consumed[side]);
  consumed[side] = state.lines.length;
  const out: string[] = [];
  for (let i = 0; i < fresh.length; i++) {
    const m = /^\|split\|(p[12])$/.exec(fresh[i]);
    if (m) {
      out.push(m[1] === side ? (fresh[i + 1] ?? '') : (fresh[i + 2] ?? ''));
      i += 2;
    } else {
      out.push(fresh[i]);
    }
  }
  return out.filter((l) => l !== '');
}

/* ------------------------------------------------------------------ */
/* battle runner                                                       */
/* ------------------------------------------------------------------ */

export async function runMatch(cfg: MatchConfig): Promise<MatchResult> {
  const bots: Record<Slot, BotConnection> = {
    p1: BotConnection.launch(cfg.botA.digest, cfg.matchId, 'p1', cfg.container),
    p2: BotConnection.launch(cfg.botB.digest, cfg.matchId, 'p2', cfg.container),
  };
  const ids: Record<Slot, string> = { p1: cfg.botA.id, p2: cfg.botB.id };
  const names: Record<Slot, string> = { p1: safeName(cfg.botA.id), p2: safeName(cfg.botB.id) };
  const timeouts: Record<Slot, number> = { p1: 0, p2: 0 };
  const illegal: Record<Slot, number> = { p1: 0, p2: 0 };
  const moveMs: Record<Slot, number[]> = { p1: [], p2: [] };
  const maxTurns = cfg.maxTurns ?? 200;

  const strike = (slot: Slot, kind: 'timeout' | 'illegal') => {
    if (kind === 'timeout') timeouts[slot]++;
    else illegal[slot]++;
  };
  const strikes = (slot: Slot) => timeouts[slot] + illegal[slot];

  try {
    for (const slot of ['p1', 'p2'] as Slot[]) {
      bots[slot].send({
        type: 'init',
        match_id: cfg.matchId,
        slot,
        format: 'gen9ou',
        team_size: 6,
        move_time_ms: cfg.moveTimeMs,
        seed: cfg.seed,
      });
    }
    await Promise.all(
      (['p1', 'p2'] as Slot[]).map(async (slot) => {
        const msg = await bots[slot].recv(cfg.moveTimeMs);
        if (msg.type !== 'ready') throw new Error(`bot ${ids[slot]} never sent ready`);
      })
    );

    const { state: cap, send } = makeCapture();
    const battle = new Battle({
      formatid: toID('gen9ou'),
      seed: simSeed(cfg.seed),
      send,
    } as any);
    battle.setPlayer('p1', { team: cfg.teamA, name: names.p1 });
    battle.setPlayer('p2', { team: cfg.teamB, name: names.p2 });
    battle.sendUpdates();

    const consumed: Record<Slot, number> = { p1: 0, p2: 0 };
    const rqid: Record<Slot, number> = { p1: 0, p2: 0 };
    let forfeit: Slot | null = null;

    const sideIdx = (slot: Slot): 0 | 1 => (slot === 'p1' ? 0 : 1);
    /** This side's full team data as the sim reports it (private to the side). */
    const ownTeamFull = (slot: Slot): unknown =>
      JSON.parse(JSON.stringify((battle.sides[sideIdx(slot)] as any).getRequestData()));

    while (!battle.ended && battle.turn < maxTurns) {
      const choices = {} as Record<Slot, string | undefined>;
      for (const slot of ['p1', 'p2'] as Slot[]) {
        const req: any = battle.sides[sideIdx(slot)].activeRequest;
        if (!req) {
          // No decision needed (isChoiceDone treats this as done).
          choices[slot] = undefined;
          continue;
        }
        if (req.wait) {
          // Nothing to decide (e.g. mid-turn faint already resolved).
          choices[slot] = 'default';
          continue;
        }
        const publicLog = takeNewLines(cap, slot, consumed);
        if (req.teamPreview) {
          choices[slot] = await teamPreviewChoice(
            bots[slot], battle, slot, publicLog, ownTeamFull(slot), cfg, strike
          );
        } else {
          // Freeze the request and stamp a synthesized rqid (the sim has no
          // rqid concept; the real server adds one).
          const observation = JSON.parse(JSON.stringify(req));
          observation.rqid = ++rqid[slot];
          choices[slot] = await actionChoice(
            bots[slot], observation, publicLog, battle.turn, cfg, slot, strike, moveMs
          );
        }
        if (strikes(slot) >= MAX_STRIKES) {
          forfeit = slot;
          break;
        }
      }
      if (forfeit) break;
      // Any sim rejection here is a bug or an exploited edge case:
      // fail the match loudly rather than silently corrupting it.
      // '' is falsy, so sides with no pending request are skipped by choose().
      battle.makeChoices(choices.p1 ?? '', choices.p2 ?? '');
      battle.sendUpdates();
    }

    let winner: Slot | null = null;
    if (forfeit) {
      winner = forfeit === 'p1' ? 'p2' : 'p1';
    } else if (battle.winner === names.p1) {
      winner = 'p1';
    } else if (battle.winner === names.p2) {
      winner = 'p2';
    }

    for (const slot of ['p1', 'p2'] as Slot[]) {
      try {
        bots[slot].send({ type: 'battle_end', winner });
      } catch {
        /* best effort */
      }
    }

    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      match_id: cfg.matchId,
      bot_a: cfg.botA.id,
      bot_b: cfg.botB.id,
      winner,
      winner_bot: winner ? ids[winner] : null,
      forfeit,
      turns: battle.turn,
      timeouts,
      illegal,
      avg_move_ms: { p1: avg(moveMs.p1), p2: avg(moveMs.p2) },
      seed: cfg.seed,
    };
  } finally {
    bots.p1.kill();
    bots.p2.kill();
  }
}

/* ------------------------------------------------------------------ */
/* team preview                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the preview listing for one side as seen by the viewer.
 * FAIRNESS: only species/types/HP/tera leave this function. The sim's Pokemon
 * objects carry full sets (moves, ability, item) — those must never be
 * serialized into a bot message.
 */
function buildPreview(battle: Battle, sideIndex: 0 | 1): PreviewMon[] {
  return battle.sides[sideIndex].pokemon.map((p: any) => ({
    name: p.species.name,
    types: [...p.types],
    hp: p.hp,
    maxhp: p.maxhp,
    tera_type: p.teraType,
  }));
}

async function teamPreviewChoice(
  bot: BotConnection,
  battle: Battle,
  slot: Slot,
  publicLog: string[],
  ownTeamFull: unknown,
  cfg: MatchConfig,
  strike: (s: Slot, k: 'timeout' | 'illegal') => void
): Promise<string> {
  const me = slot === 'p1' ? 0 : 1;
  const own = buildPreview(battle, me as 0 | 1);
  const opp = buildPreview(battle, (1 - me) as 0 | 1);
  const fallback = `team ${own.map((_, i) => i + 1).join(', ')}`;

  bot.send({ type: 'team_preview', own_team: own, opp_team: opp, own_team_full: ownTeamFull, public_log: publicLog });
  try {
    const msg = await bot.recv(cfg.moveTimeMs);
    if (msg.type !== 'lead' || !isPermutation(msg.order, own.length)) {
      strike(slot, 'illegal');
      return fallback;
    }
    return `team ${msg.order.map((i: number) => i + 1).join(', ')}`;
  } catch {
    strike(slot, 'timeout');
    return fallback;
  }
}

function isPermutation(order: unknown, n: number): order is number[] {
  return (
    Array.isArray(order) &&
    order.length === n &&
    order.every((x) => Number.isInteger(x) && x >= 0 && x < n) &&
    new Set(order).size === n
  );
}

/* ------------------------------------------------------------------ */
/* mid-battle decisions                                                */
/* ------------------------------------------------------------------ */

async function actionChoice(
  bot: BotConnection,
  observation: any,
  publicLog: string[],
  turn: number,
  cfg: MatchConfig,
  slot: Slot,
  strike: (s: Slot, k: 'timeout' | 'illegal') => void,
  moveMs: Record<Slot, number[]>
): Promise<string> {
  bot.send({ type: 'request', turn, observation, public_log: publicLog, time_ms: cfg.moveTimeMs });
  const t0 = Date.now();
  try {
    const msg = await bot.recv(cfg.moveTimeMs);
    moveMs[slot].push(Date.now() - t0);
    if (msg.type !== 'action' || typeof msg.action !== 'string' || !isLegalChoice(observation, msg.action.trim())) {
      strike(slot, 'illegal');
      return firstLegal(observation);
    }
    return normalizeChoice(msg.action.trim());
  } catch {
    moveMs[slot].push(Date.now() - t0);
    strike(slot, 'timeout');
    return firstLegal(observation);
  }
}

/** Normalize accepted choice spellings to the sim's canonical form. */
function normalizeChoice(action: string): string {
  return action.replace(/ terastallize$/, ' tera');
}

/** Structural legality check against the public request. Catches bad indexes,
 *  disabled/PP-empty moves, fainted switch targets, and trapped switches. */
function isLegalChoice(req: any, action: string): boolean {
  const active = req.active?.[0];
  if (!active) return action === 'pass';

  const a = normalizeChoice(action);
  let m = /^move (\d+)( tera)?$/.exec(a);
  if (m) {
    const i = parseInt(m[1], 10) - 1;
    const move = active.moves?.[i];
    if (!move || move.disabled || (move.pp ?? 1) <= 0) return false;
    if (m[2] && !active.canTerastallize) return false;
    return true;
  }
  m = /^switch (\d+)$/.exec(a);
  if (m) {
    if (active.trapped) return false;
    const i = parseInt(m[1], 10) - 1;
    const target = req.side?.pokemon?.[i];
    return !!target && !target.active && target.condition !== '0 fnt';
  }
  return a === 'pass';
}

function firstLegal(req: any): string {
  const active = req.active?.[0];
  if (!active) return 'pass';
  const moves = active.moves ?? [];
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    if (!mv.disabled && (mv.pp ?? 1) > 0) return `move ${i + 1}`;
  }
  const team = req.side?.pokemon ?? [];
  for (let i = 0; i < team.length; i++) {
    if (!team[i].active && team[i].condition !== '0 fnt') return `switch ${i + 1}`;
  }
  return 'pass';
}
