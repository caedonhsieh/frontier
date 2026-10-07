/**
 * Trusted battle runner. The worker owns the true game state (@pkmn/sim);
 * bot containers only ever receive their fair public observation.
 *
 * Fairness-critical: the opponent's hidden information (sets, unrevealed
 * details) is NEVER serialized into a message. See buildPreview() below.
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

    const battle = new Battle({ formatid: toID('gen9ou'), seed: simSeed(cfg.seed) });
    battle.setPlayer('p1', { team: cfg.teamA, name: names.p1 });
    battle.setPlayer('p2', { team: cfg.teamB, name: names.p2 });

    let forfeit: Slot | null = null;

    while (!battle.ended && battle.turn < maxTurns) {
      const choices = {} as Record<Slot, string>;
      for (const slot of ['p1', 'p2'] as Slot[]) {
        const side = battle.sides[slot === 'p1' ? 0 : 1];
        const req: any = side.activeRequest;
        if (!req) {
          choices[slot] = 'pass';
          continue;
        }
        choices[slot] = req.teamPreview
          ? await teamPreviewChoice(bots[slot], battle, slot, cfg, strike)
          : await actionChoice(bots[slot], req, battle.turn, cfg, slot, strike, moveMs);
        if (strikes(slot) >= MAX_STRIKES) {
          forfeit = slot;
          break;
        }
      }
      if (forfeit) break;
      // Any sim rejection here is a bug or an exploited edge case:
      // fail the match loudly rather than silently corrupting it.
      battle.makeChoices(choices.p1, choices.p2);
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
 * FAIRNESS: only species/types/HP leave this function. The sim's Pokemon
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
  cfg: MatchConfig,
  strike: (s: Slot, k: 'timeout' | 'illegal') => void
): Promise<string> {
  const me = slot === 'p1' ? 0 : 1;
  const own = buildPreview(battle, me as 0 | 1);
  const opp = buildPreview(battle, (1 - me) as 0 | 1);
  const fallback = `team ${own.map((_, i) => i + 1).join(', ')}`;

  bot.send({ type: 'team_preview', own_team: own, opp_team: opp });
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
  req: any,
  turn: number,
  cfg: MatchConfig,
  slot: Slot,
  strike: (s: Slot, k: 'timeout' | 'illegal') => void,
  moveMs: Record<Slot, number[]>
): Promise<string> {
  bot.send({ type: 'request', turn, observation: req, time_ms: cfg.moveTimeMs });
  const t0 = Date.now();
  try {
    const msg = await bot.recv(cfg.moveTimeMs);
    moveMs[slot].push(Date.now() - t0);
    if (msg.type !== 'action' || typeof msg.action !== 'string' || !isLegalChoice(req, msg.action.trim())) {
      strike(slot, 'illegal');
      return firstLegal(req);
    }
    return msg.action.trim();
  } catch {
    moveMs[slot].push(Date.now() - t0);
    strike(slot, 'timeout');
    return firstLegal(req);
  }
}

/** Structural legality check against the public request. Catches bad indexes,
 *  disabled/PP-empty moves, fainted switch targets, and trapped switches. */
function isLegalChoice(req: any, action: string): boolean {
  const active = req.active?.[0];
  if (!active) return action === 'pass';

  let m = /^move (\d+)( tera)?$/.exec(action);
  if (m) {
    const i = parseInt(m[1], 10) - 1;
    const move = active.moves?.[i];
    if (!move || move.disabled || (move.pp ?? 1) <= 0) return false;
    if (m[2] && !active.canTerastallize) return false;
    return true;
  }
  m = /^switch (\d+)$/.exec(action);
  if (m) {
    if (active.trapped) return false;
    const i = parseInt(m[1], 10) - 1;
    const target = req.side?.pokemon?.[i];
    return !!target && !target.active && target.condition !== '0 fnt';
  }
  return action === 'pass';
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
