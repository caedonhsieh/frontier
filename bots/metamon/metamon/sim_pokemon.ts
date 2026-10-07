// Battle state tracker — TypeScript port of:
//   metamon/backend/replay_parser/replay_state.py (Pokemon, Move, Turn, Boosts)
//   metamon/backend/replay_parser/forward.py      (SimProtocol + _parse_*)
//   metamon/env/metamon_battle.py                (request -> turn updates)
//
// Faithful to the Python semantics, including quirks (e.g. Move deepcopy
// resetting maximumPp, matching by name then had_name).

import { ACTION_COUNTABLE_EFFECTS, STACKABLE_CONDITION_NAMES } from "./data/enums.js";
import {
  MOVES,
  identifyFromDetails,
  lookupPokedex,
  type MoveEntry,
} from "./dex.js";
import {
  cleanName,
  cleanNoNumbers,
  effectFromMessage,
  fieldFromMessage,
  idstr,
  moveName,
  parseAbility,
  parseExtra,
  parseFromEffectOf,
  parseHpFraction,
  parseItem,
  sideConditionFromMessage,
  statusFromCode,
  weatherFromMessage,
} from "./strutil.js";

// ---------------------------------------------------------------------------
// sentinels (poke-env Nothing)
// ---------------------------------------------------------------------------
export const NO_ABILITY = "NO_ABILITY";
export const NO_ITEM = "NO_ITEM";
export const NO_STATUS = "NO_STATUS";
export const NO_WEATHER = "NO_WEATHER";

// ---------------------------------------------------------------------------
// Boosts
// ---------------------------------------------------------------------------
export type BoostKey =
  | "atk"
  | "spa"
  | "def"
  | "spd"
  | "spe"
  | "accuracy"
  | "evasion";

const BOOST_ATTRS: BoostKey[] = [
  "atk",
  "spa",
  "def",
  "spd",
  "spe",
  "accuracy",
  "evasion",
];

export function parseBoost(s: string): BoostKey {
  const t = s.split("-").join("").split(" ").join("");
  switch (t) {
    case "atk":
    case "attack":
      return "atk";
    case "spa":
    case "specialattack":
      return "spa";
    case "def":
    case "defence":
    case "defense":
      return "def";
    case "spd":
    case "specialdefense":
      return "spd";
    case "spe":
    case "speed":
      return "spe";
    case "accuracy":
      return "accuracy";
    case "evasion":
      return "evasion";
    default:
      throw new Error(`RareValueError(Unknown boost ${s})`);
  }
}

export class Boosts {
  atk = 0;
  spa = 0;
  def = 0;
  spd = 0;
  spe = 0;
  accuracy = 0;
  evasion = 0;

  setToWithStr(s: string, value: number): void {
    this[parseBoost(s)] = value;
  }
  changeWithStr(s: string, value: number): void {
    const k = parseBoost(s);
    this[k] += value;
  }
  getBoost(s: string): number {
    return this[parseBoost(s)];
  }
  toDict(): Record<BoostKey, number> {
    return {
      atk: this.atk,
      spa: this.spa,
      def: this.def,
      spd: this.spd,
      spe: this.spe,
      accuracy: this.accuracy,
      evasion: this.evasion,
    };
  }
  clone(): Boosts {
    const b = new Boosts();
    for (const k of BOOST_ATTRS) b[k] = this[k];
    return b;
  }
}

// ---------------------------------------------------------------------------
// SimMove — mirrors replay_state.Move (over poke-env Move)
// ---------------------------------------------------------------------------
const RECHARGE_FIGHT_FALLBACK: MoveEntry = {
  name: "",
  type: "normal",
  category: "Special",
  basePower: 0,
  accuracy: 1,
  priority: 0,
  pp: 1,
  charge: false,
};

export class SimMove {
  lookupName: string;
  name: string;
  pp: number;
  maximumPp: number;
  moveType: string;
  category: string;
  basePower: number;
  accuracy: number | true;
  priority: number;
  chargeMove: boolean;
  private basePp: number;

  constructor(displayName: string) {
    const lookup = moveName(displayName);
    let entry = MOVES[lookup] as MoveEntry | undefined;
    let officialName: string;
    if (entry === undefined) {
      if (lookup === "recharge" || lookup === "fight") {
        entry = { ...RECHARGE_FIGHT_FALLBACK, name: displayName };
        officialName = displayName;
      } else {
        throw new Error(`MovedexMissingEntry(${displayName}, ${lookup})`);
      }
    } else {
      officialName = entry.name;
    }
    this.lookupName = lookup;
    this.name = officialName;
    this.chargeMove = entry.charge;
    this.moveType = entry.type;
    this.category = entry.category;
    this.basePower = entry.basePower;
    this.accuracy = entry.accuracy as number | true;
    this.priority = entry.priority;
    this.basePp = entry.pp;
    const maxPp = Math.floor((entry.pp * 8) / 5);
    this.pp = maxPp;
    this.maximumPp = maxPp;
  }

  setPp(pp: number): void {
    this.pp = pp;
  }

  /** poke-env Move.max_pp = entry["pp"] * 8 // 5 */
  get maxPp(): number {
    return Math.floor((this.basePp * 8) / 5);
  }

  fromTransform(): SimMove {
    const m = new SimMove(this.name);
    m.setPp(5);
    m.maximumPp = 5;
    return m;
  }

  /** mirrors Move.__deepcopy__ — note the upstream quirk: maximumPp is NOT
   *  carried over (the original code assigns to self, a no-op), so the copy
   *  gets a fresh maximumPp. */
  clone(): SimMove {
    const m = new SimMove(this.name);
    m.pp = this.pp;
    return m;
  }
}

// ---------------------------------------------------------------------------
// SimPokemon — mirrors replay_state.Pokemon
// ---------------------------------------------------------------------------
let uidCounter = 0;

export interface Targeting {
  pokemon: SimPokemon | null;
  move: string;
}

export class SimPokemon {
  name: string | null = null;
  hadName: string | null = null;
  nickname: string | null = null;
  uniqueId: string;
  lvl: number;
  gen: number;

  activeAbility: string | null = null;
  hadAbility: string | null = null;
  type: string[] | null = null;
  hadType: string[] | null = null;
  teraType: string | null = null;
  baseStats: Record<string, number> = {};

  activeItem: string | null = null;
  hadItem: string | null = null;
  moves: Map<string, SimMove> = new Map();
  hadMoves: Map<string, SimMove> = new Map();
  moveChangeToFrom: Map<string, string> = new Map();

  lastUsedMove: SimMove | null = null;
  boosts: Boosts = new Boosts();
  status: string = NO_STATUS;
  effects: Map<string, number> = new Map();
  currentHp: number | null = null;
  maxHp: number | null = null;

  transformedThisTurn = false;
  transformedInto: SimPokemon | null = null;

  protected = false;
  lastTarget: Targeting | null = null;
  lastTargetedBy: Targeting | null = null;
  tricking: SimPokemon | null = null;

  constructor(name: string, lvl: number, gen: number, uniqueId?: string) {
    this.lvl = lvl;
    this.gen = gen;
    this.uniqueId = uniqueId ?? `uid-${uidCounter++}-${Math.random().toString(36).slice(2)}`;
    this.updatePokedexInfo(name);
  }

  updatePokedexInfo(name: string): void {
    const info = lookupPokedex(name);
    this.name = info.name;
    if (this.hadName === null) this.hadName = info.baseSpecies;
    this.type = [...info.types];
    if (this.hadType === null) this.hadType = [...info.types];
    this.baseStats = { ...info.baseStats };
    const possibleAbilities = Object.values(info.abilities);
    if (info.requiredAbility != null) {
      this.revealAbility(info.requiredAbility);
    } else if (possibleAbilities.length === 1) {
      let only = possibleAbilities[0];
      if (only === "No Ability") only = NO_ABILITY;
      this.revealAbility(only);
    }
    if (info.requiredItem != null) this.revealItem(info.requiredItem);
    if (info.requiredTeraType != null && this.gen === 9) {
      this.teraType = info.requiredTeraType;
    }
  }

  onSwitchOut(): void {
    this.boosts = new Boosts();
    this.transformedInto = null;
    const nm = new Map<string, SimMove>();
    for (const [k, v] of this.hadMoves) nm.set(k, v.clone());
    this.moves = nm;
    this.activeAbility = this.hadAbility;
    this.moveChangeToFrom = new Map();
    this.type = this.hadType ? [...this.hadType] : null;
    this.effects = new Map();
  }

  onEndOfTurn(): void {
    this.lastTarget = null;
    this.lastTargetedBy = null;
    this.protected = false;
    this.tricking = null;
    this.transformedThisTurn = false;
  }

  mimic(moveNameStr: string): void {
    if (!this.moves.has("Mimic") || this.lastTarget === null)
      throw new Error("MimicMiss(Mimic not in moveset)");
    if (this.lastTarget.move !== "Mimic")
      throw new Error("MimicMiss(Lost reference to Mimic target)");
    const copiedMove = new SimMove(moveNameStr);
    this.lastTarget.pokemon!.revealMove(copiedMove.clone());
    const pp = this.gen === 1 ? this.moves.get("Mimic")!.pp : 5;
    copiedMove.setPp(pp);
    copiedMove.maximumPp = pp;
    this.moveChangeToFrom.set(copiedMove.name, "Mimic");
    this.moves.delete("Mimic");
    this.moves.set(copiedMove.name, copiedMove);
  }

  getPpForMoveName(mn: string): number | undefined {
    return this.moves.get(mn)?.pp;
  }

  revealMove(move: SimMove): void {
    if (
      move.name === "Struggle" ||
      move.name === "Recharge" ||
      move.name === "Fight"
    )
      return;
    if (this.transformedInto !== null) {
      if (!this.moves.has(move.name))
        this.moves.set(move.name, move.fromTransform());
    } else {
      if (!this.moves.has(move.name)) {
        this.moves.set(move.name, move);
        this.hadMoves.set(move.name, move.clone());
      }
    }
  }

  revealAbility(ability: string): void {
    this.activeAbility = ability;
    if (this.hadAbility === null && this.transformedInto === null)
      this.hadAbility = ability;
  }

  revealItem(item: string): void {
    this.activeItem = item;
    if (this.hadItem === null) this.hadItem = item;
  }

  transform(other: SimPokemon): void {
    this.transformedThisTurn = true;
    this.transformedInto = other;
    this.boosts = other.boosts.clone();
    this.activeAbility = other.activeAbility;
    const nm = new Map<string, SimMove>();
    for (const [k, v] of other.moves) nm.set(k, v.fromTransform());
    this.moves = nm;
  }

  get lastUsedMoveName(): string | null {
    return this.lastUsedMove ? this.lastUsedMove.name : null;
  }

  useMove(move: SimMove, ppUsed: number): void {
    this.lastUsedMove = move;
    if (move.name === "Struggle") return;
    this.revealMove(move);
    if (!this.moves.has(move.name)) return;
    if (this.transformedInto === null && this.hadMoves.has(move.name)) {
      const currPp = this.hadMoves.get(move.name)!.pp;
      this.hadMoves
        .get(move.name)!
        .setPp(currPp - (currPp > 1 ? ppUsed : Math.min(ppUsed, 1)));
    }
    const currPp = this.moves.get(move.name)!.pp;
    this.moves
      .get(move.name)!
      .setPp(currPp - (currPp > 1 ? ppUsed : Math.min(ppUsed, 1)));
  }

  startEffect(effect: string): void {
    if (!this.effects.has(effect)) {
      this.effects.set(effect, 0);
    } else if (ACTION_COUNTABLE_EFFECTS.has(effect)) {
      this.effects.set(effect, this.effects.get(effect)! + 1);
    }
  }

  endEffect(effect: string): void {
    this.effects.delete(effect);
  }

  get currentHpFraction(): number {
    if (!this.currentHp) return 0.0;
    return this.currentHp / this.maxHp!;
  }

  get fainted(): boolean {
    return this.status === "FNT";
  }

  clone(): SimPokemon {
    const c = new SimPokemon(this.name ?? "missingno", this.lvl, this.gen, this.uniqueId);
    c.hadName = this.hadName;
    c.nickname = this.nickname;
    c.activeAbility = this.activeAbility;
    c.hadAbility = this.hadAbility;
    c.type = this.type ? [...this.type] : null;
    c.hadType = this.hadType ? [...this.hadType] : null;
    c.teraType = this.teraType;
    c.baseStats = { ...this.baseStats };
    c.activeItem = this.activeItem;
    c.hadItem = this.hadItem;
    const mv = new Map<string, SimMove>();
    for (const [k, v] of this.moves) mv.set(k, v.clone());
    c.moves = mv;
    const hm = new Map<string, SimMove>();
    for (const [k, v] of this.hadMoves) hm.set(k, v.clone());
    c.hadMoves = hm;
    c.moveChangeToFrom = new Map(this.moveChangeToFrom);
    c.lastUsedMove = this.lastUsedMove ? this.lastUsedMove.clone() : null;
    c.boosts = this.boosts.clone();
    c.status = this.status;
    c.effects = new Map(this.effects);
    c.currentHp = this.currentHp;
    c.maxHp = this.maxHp;
    c.transformedThisTurn = this.transformedThisTurn;
    // transformedInto: remapped by Turn.clone via identity map
    c.protected = this.protected;
    c.tricking = null;
    return c;
  }
}
