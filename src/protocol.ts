/**
 * Frontier container protocol v1.
 * JSON lines over stdin/stdout; one complete JSON object per line.
 * See PROTOCOL.md for the full contract.
 */

export type Slot = 'p1' | 'p2';

/* ------------------------- worker -> bot ------------------------- */

export interface InitMessage {
  type: 'init';
  match_id: string;
  slot: Slot;
  format: string;
  team_size: number;
  move_time_ms: number;
  /** For the bot's own RNG. NOT the battle seed; reveals nothing about outcomes. */
  seed: number;
}

export interface PreviewMon {
  name: string;
  types: string[];
  hp: number;
  maxhp: number;
  /** Revealed at preview in gen 9. */
  tera_type?: string;
}

export interface TeamPreviewMessage {
  type: 'team_preview';
  own_team: PreviewMon[];
  opp_team: PreviewMon[];
  /**
   * Your full team data as reported by the sim (moves, stats, abilities,
   * items) - private to you, needed by bots that reason about their own sets.
   */
  own_team_full: unknown;
  /** Battle protocol lines since battle start (|split| resolved for you). */
  public_log: string[];
}

export interface RequestMessage {
  type: 'request';
  turn: number;
  /**
   * The side's public battle state from the sim: your active Pokemon
   * (moves, PP, disabled flags, trapping), your full bench, and the
   * opponent's active Pokemon as publicly visible. Hidden opponent info
   * (sets, unrevealed mons' details) is never included.
   * `rqid` is synthesized by the arena (increments per request).
   */
  observation: unknown;
  /** Battle protocol lines since your last decision (|split| resolved for you). */
  public_log: string[];
  time_ms: number;
}

export interface BattleEndMessage {
  type: 'battle_end';
  winner: Slot | null;
}

export type WorkerMessage =
  | InitMessage
  | TeamPreviewMessage
  | RequestMessage
  | BattleEndMessage;

/* ------------------------- bot -> worker ------------------------- */

export type BotMessage =
  | { type: 'ready' }
  | { type: 'lead'; order: number[] } // 0-indexed permutation of team positions
  | { type: 'action'; action: string }; // e.g. "move 1", "move 2 tera", "switch 3", "pass"
