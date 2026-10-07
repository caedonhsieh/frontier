// UniversalState + TeamPreviewObservationSpace + reward + action mapping.
// TypeScript port of metamon/interface.py (UniversalMove/UniversalPokemon/
// UniversalState, Default/Expanded/TeamPreviewObservationSpace,
// AggressiveShapedReward, UniversalAction.action_idx_to_BattleOrder).
import {
  cleanName,
  cleanNoNumbers,
  pokemonName,
  moveName,
} from "./strutil.js";
import { getPokedexEntry } from "./dex.js";
import { SimMove, SimPokemon } from "./sim_pokemon.js";
import { BattleTracker } from "./battle.js";

/** Code-point string comparison matching Python's sorted() on ASCII strings. */
export function pyStrCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// UniversalMove
// ---------------------------------------------------------------------------

export interface UMove {
  name: string; // move_name(lookup), e.g. "Thunderbolt", "Hidden Power"
  category: string; // clean_name, e.g. "special"
  basePower: number;
  moveType: string; // clean_name, e.g. "electric"
  accuracy: number; // 0..1 scale (poke-env Move.accuracy convention)
  priority: number;
  currentPp: number;
  maxPp: number;
}

export function blankUMove(): UMove {
  return {
    name: "nomove",
    category: "nocategory",
    basePower: 0,
    moveType: "notype",
    accuracy: 1.0,
    priority: 0,
    currentPp: 0,
    maxPp: 0,
  };
}

export function uMoveFromSim(m: SimMove | null | undefined): UMove {
  if (!m) return blankUMove();
  return {
    name: moveName(m.lookupName),
    category: cleanName(m.category),
    basePower: m.basePower,
    moveType: cleanName(m.moveType),
    // poke-env Move.accuracy is 0..1 scale (True -> 1.0)
    accuracy: m.accuracy === true ? 1.0 : m.accuracy / 100,
    priority: m.priority,
    currentPp: m.pp,
    maxPp: m.maximumPp,
  };
}

/** Python: sorted(moves, key=lambda m: m.name). */
export function consistentMoveOrder(moves: UMove[]): UMove[] {
  return [...moves].sort((a, b) => pyStrCmp(a.name, b.name));
}

// ---------------------------------------------------------------------------
// UniversalPokemon
// ---------------------------------------------------------------------------

export interface UPokemon {
  name: string; // pokemon_name(species)
  baseSpecies: string; // pokemon_name(base_species)
  hpPct: number;
  types: string; // sorted " " joined, force_two
  teraType: string;
  item: string;
  ability: string;
  lvl: number;
  status: string; // "brn" / "nostatus"
  effect: string; // "noeffect" / cleaned most-recent effect
  moves: UMove[]; // up to 4, insertion order
  boosts: Record<string, number>;
  baseStats: Record<string, number>;
}

function universalItems(item: string | null): string {
  let itemStr: string;
  if (item === null || item === "unknown_item") itemStr = "unknownitem";
  else if (item === "NO_ITEM") itemStr = "NO_ITEM";
  else if (["", "No Item", "noitem"].includes(item.trim()))
    itemStr = "NO_ITEM";
  else itemStr = item;
  return cleanNoNumbers(itemStr);
}

function universalAbilities(ability: string | null): string {
  let abilityStr: string;
  if (ability === null || ability === "unknown_ability")
    abilityStr = "unknownability";
  else if (ability === "NO_ABILITY") abilityStr = "NO_ABILITY";
  else if (["", "No Ability", "noability"].includes(ability.trim()))
    abilityStr = "NO_ABILITY";
  else abilityStr = ability;
  return cleanNoNumbers(abilityStr);
}

function universalStatus(status: string): string {
  if (status === "NO_STATUS") return "nostatus";
  return cleanNoNumbers(status);
}

function universalTypes(
  typeRep: (string | null)[],
  forceTwo = true
): string {
  const reps = [...typeRep];
  if (forceTwo) while (reps.length < 2) reps.push(null);
  const strs = reps.map((t) => (t === null ? "notype" : cleanName(t)));
  strs.sort(pyStrCmp);
  return strs.join(" ");
}

/** poke-env ability property: temporary_ability wins unless NO_ABILITY/None. */
function effectiveAbility(p: SimPokemon): string | null {
  if (p.activeAbility !== null && p.activeAbility !== "NO_ABILITY")
    return p.activeAbility;
  return p.hadAbility;
}

/** Most recent effect = min by insertion counter, ties -> first inserted. */
function mostRecentEffect(p: SimPokemon): string | null {
  let best: string | null = null;
  let bestVal = Infinity;
  for (const [name, val] of p.effects) {
    if (val < bestVal) {
      bestVal = val;
      best = name;
    }
  }
  return best;
}

export function uPokemonFromSim(p: SimPokemon): UPokemon {
  const species = cleanName(p.name ?? "");
  const dexEntry = getPokedexEntry(species);
  const baseSpecies = pokemonName(
    cleanName(dexEntry?.baseSpecies ?? species)
  );
  const moves = [...p.moves.values()].slice(0, 4).map(uMoveFromSim);
  const effectName = mostRecentEffect(p);
  return {
    name: pokemonName(species),
    baseSpecies,
    hpPct: p.currentHp ? p.currentHp / (p.maxHp ?? 0) : 0.0,
    types: universalTypes((p.type ?? []).slice(0, 2), true),
    teraType: universalTypes([p.teraType], false),
    item: universalItems(p.activeItem),
    ability: universalAbilities(effectiveAbility(p)),
    lvl: p.lvl,
    status: universalStatus(p.status),
    effect: effectName ? cleanNoNumbers(effectName) : "noeffect",
    moves,
    boosts: { ...p.boosts.toDict() },
    baseStats: { ...p.baseStats },
  };
}

/** Python: sorted(pokemons, key=lambda p: p.base_species). */
export function consistentPokemonOrder(pokemons: UPokemon[]): UPokemon[] {
  return [...pokemons].sort((a, b) => pyStrCmp(a.baseSpecies, b.baseSpecies));
}

// ---------------------------------------------------------------------------
// UniversalState
// ---------------------------------------------------------------------------

export interface UniversalState {
  format: string;
  agentFormat: string;
  playerActivePokemon: UPokemon;
  opponentActivePokemon: UPokemon;
  availableSwitches: UPokemon[];
  playerPrevMove: UMove;
  opponentPrevMove: UMove;
  opponentsRemaining: number;
  playerConditions: string;
  opponentConditions: string;
  weather: string;
  battleField: string;
  forcedSwitch: boolean;
  battleWon: boolean;
  battleLost: boolean;
  canTera: boolean;
  opponentTeampreview: string[];
}

const FORMAT_ALIASES: Record<string, string> = {
  gen1oulongtimer: "gen1ou",
  gen9oulongtimer: "gen9ou",
};

function formatForAgent(fmt: string): string {
  const lower = fmt.toLowerCase();
  return FORMAT_ALIASES[lower] ?? lower;
}

function universalConditions(conditionRep: Map<string, number>): string {
  if (conditionRep.size === 0) return "noconditions";
  let best: string | null = null;
  let bestVal = -Infinity;
  for (const [name, val] of conditionRep) {
    if (val > bestVal) {
      bestVal = val;
      best = name;
    }
  }
  return cleanNoNumbers(best!);
}

function universalField(fieldRep: Map<string, number>): string {
  if (fieldRep.size === 0) return "nofield";
  let best: string | null = null;
  let bestVal = -Infinity;
  for (const [name, val] of fieldRep) {
    if (val > bestVal) {
      bestVal = val;
      best = name;
    }
  }
  return cleanNoNumbers(best!);
}

function universalWeather(weather: string): string {
  if (!weather || weather === "NO_WEATHER") return "noweather";
  return cleanNoNumbers(weather);
}

/** Mirror of UniversalState.from_Battle for the live tracker. */
export function universalStateFromTracker(
  tracker: BattleTracker,
  battleTag: string
): UniversalState {
  const p1 = tracker.playerRole === "p1";
  const turn = tracker.currentTurn;
  const active = turn.getActivePokemon(p1)[0]!;
  const oppActive = turn.getActivePokemon(!p1)[0]!;
  const teamDict = turn.getTeamDict(p1);
  const oppTeamDict = turn.getTeamDict(!p1);

  const activeId = active.uniqueId;
  const switches: UPokemon[] = [];
  if (tracker.reviving) {
    for (const p of teamDict.values()) {
      if (p.status === "FNT" && p.uniqueId !== activeId)
        switches.push(uPokemonFromSim(p));
    }
  } else {
    for (const p of teamDict.values()) {
      if (p.status !== "FNT" && p.uniqueId !== activeId)
        switches.push(uPokemonFromSim(p));
    }
  }

  let opponentsRemaining = 6;
  for (const p of oppTeamDict.values()) {
    if (p.status === "FNT") opponentsRemaining--;
  }

  const teampreview = turn.getTeampreview(!p1);
  const opponentTeampreview = teampreview
    .filter((p) => p !== null)
    .map((p) => {
      const species = cleanName(p!.name ?? "");
      const dexEntry = getPokedexEntry(species);
      return pokemonName(cleanName(dexEntry?.baseSpecies ?? species));
    });

  const winner = tracker.protocol.winner;
  const won = winner !== null && winner !== undefined
    ? (p1 ? winner === "PLAYER_1" : winner === "PLAYER_2")
    : null;

  const format = battleTag.split("-")[1] ?? battleTag;
  return {
    format,
    agentFormat: formatForAgent(format),
    playerActivePokemon: uPokemonFromSim(active),
    opponentActivePokemon: uPokemonFromSim(oppActive),
    availableSwitches: switches,
    playerPrevMove: uMoveFromSim(active.lastUsedMove),
    opponentPrevMove: uMoveFromSim(oppActive.lastUsedMove),
    opponentsRemaining,
    playerConditions: universalConditions(turn.getConditions(p1)),
    opponentConditions: universalConditions(turn.getConditions(!p1)),
    weather: universalWeather(turn.weather),
    battleField: universalField(turn.battleField),
    forcedSwitch: tracker.forceSwitch,
    battleWon: won === true,
    battleLost: won === false,
    canTera: tracker.canTera,
    opponentTeampreview,
  };
}

// ---------------------------------------------------------------------------
// Observation encoding
// (PAC-OpponentMoveObservationSpace = PatchPokeAgentTeraBug(
//    OpponentMoveObservationSpace(TeamPreviewObservationSpace(
//      ExpandedObservationSpace(DefaultObservationSpace)))))
// ---------------------------------------------------------------------------

/** PAC tera patch: player active + available switches report tera_type "notype".
 *  Applied to a shallow copy used ONLY for observation encoding (Python deep-
 *  copies the state inside PatchPokeAgentTeraBug.state_to_obs). */
function patchPlayerTeraBug(state: UniversalState): UniversalState {
  return {
    ...state,
    playerActivePokemon: { ...state.playerActivePokemon, teraType: "notype" },
    availableSwitches: state.availableSwitches.map((p) => ({
      ...p,
      teraType: "notype",
    })),
  };
}

function moveStringFeatures(move: UMove, active: boolean): string[] {
  const out = [cleanName(move.name)];
  // OpponentMoveObservationSpace drops the category token for active moves
  // (trades 4 tokens to make room for the opponent's revealed moves).
  if (active) out.push(cleanName(move.moveType));
  return out;
}

function movePadString(active: boolean): string[] {
  // OpponentMoveObservationSpace: 2 blanks for active, 1 for inactive.
  return new Array(active ? 2 : 1).fill("<blank>");
}

function moveNumericalFeatures(move: UMove, active: boolean): number[] {
  if (!active) return [];
  return [move.basePower / 200.0, move.accuracy as number, move.priority / 5.0];
}

function movePadNumerical(active: boolean): number[] {
  if (!active) return [];
  return [-2.0, -2.0, -2.0, -2.0];
}

function ppWarning(move: UMove): number {
  const ratio = move.currentPp / move.maxPp;
  return (
    (ratio >= 0.5 ? 1 : 0) + (ratio >= 0.25 ? 1 : 0) + (ratio > 0 ? 1 : 0)
  );
}

function pokemonStringFeatures(pokemon: UPokemon, active: boolean): string[] {
  const out = [pokemon.name, pokemon.item, pokemon.ability];
  if (active) {
    out.push(pokemon.types, pokemon.effect, pokemon.status);
  } else {
    out.push("<moveset>");
    let moveNum = -1;
    for (const [i, move] of consistentMoveOrder(pokemon.moves).entries()) {
      moveNum = i;
      out.push(...moveStringFeatures(move, false));
    }
    while (moveNum < 3) {
      out.push(...movePadString(false));
      moveNum++;
    }
  }
  out.push(pokemon.teraType);
  return out;
}

function pokemonPadString(active: boolean): string[] {
  const blanks = 4 + (active ? 4 : 5);
  return new Array(blanks).fill("<blank>");
}

/** OpponentMoveObservationSpace: base features + 4 revealed-move name tokens. */
function opponentPokemonStringFeatures(pokemon: UPokemon, active: boolean): string[] {
  const base = pokemonStringFeatures(pokemon, active);
  const moves = new Array<string>(4).fill("<blank>");
  for (const [i, move] of consistentMoveOrder(pokemon.moves).slice(0, 4).entries()) {
    moves[i] = cleanName(move.name);
  }
  return base.concat(moves);
}

function pokemonNumericalFeatures(
  pokemon: UPokemon,
  active: boolean
): number[] {
  const out = [pokemon.hpPct];
  if (active) {
    const stat = (s: string) => pokemon.baseStats[s] / 255.0;
    const boost = (b: string) => pokemon.boosts[b] / 6.0;
    out.push(pokemon.lvl / 100.0);
    for (const s of ["atk", "spa", "def", "spd", "spe", "hp"])
      out.push(stat(s));
    for (const b of ["atk", "spa", "def", "spd", "spe", "accuracy", "evasion"])
      out.push(boost(b));
  }
  return out;
}

function pokemonPadNumerical(active: boolean): number[] {
  const blanks = 1 + (active ? 14 : 0);
  return new Array(blanks).fill(-2.0);
}

export interface TextNumbers {
  text: string;
  numbers: number[];
}

/** PAC-OpponentMoveObservationSpace.state_to_obs (includes PP warnings). */
export function stateToObs(state: UniversalState): TextNumbers {
  const patched = patchPlayerTeraBug(state);
  const playerStr = [
    "<player>",
    ...pokemonStringFeatures(patched.playerActivePokemon, true),
  ];
  const numerical = [
    patched.opponentsRemaining / 6.0,
    ...pokemonNumericalFeatures(patched.playerActivePokemon, true),
  ];

  const moveStr: string[] = [];
  let moveNum = -1;
  for (const [i, move] of consistentMoveOrder(
    patched.playerActivePokemon.moves
  ).entries()) {
    moveNum = i;
    moveStr.push("<move>", ...moveStringFeatures(move, true));
    numerical.push(
      ...moveNumericalFeatures(move, true),
      ppWarning(move)
    );
  }
  while (moveNum < 3) {
    moveStr.push("<move>", ...movePadString(true));
    numerical.push(...movePadNumerical(true));
    moveNum++;
  }

  const switchStr: string[] = [];
  let switchNum = -1;
  for (const [i, sw] of consistentPokemonOrder(
    patched.availableSwitches
  ).entries()) {
    switchNum = i;
    switchStr.push("<switch>", ...pokemonStringFeatures(sw, false));
    numerical.push(...pokemonNumericalFeatures(sw, false));
  }
  while (switchNum < 4) {
    switchStr.push("<switch>", ...pokemonPadString(false));
    numerical.push(...pokemonPadNumerical(false));
    switchNum++;
  }

  const forceSwitch = patched.forcedSwitch ? "<forcedswitch>" : "<anychoice>";
  const opponentStr = [
    "<opponent>",
    ...opponentPokemonStringFeatures(patched.opponentActivePokemon, true),
  ];
  numerical.push(
    ...pokemonNumericalFeatures(patched.opponentActivePokemon, true)
  );
  const globalStr = [
    "<conditions>",
    patched.weather,
    patched.playerConditions,
    patched.opponentConditions,
  ];
  const prevMoveStr = [
    "<player_prev>",
    ...moveStringFeatures(patched.playerPrevMove, false),
    "<opp_prev>",
    ...moveStringFeatures(patched.opponentPrevMove, false),
  ];
  const fullTextList = [
    `<${patched.agentFormat}>`,
    forceSwitch,
    ...playerStr,
    ...moveStr,
    ...switchStr,
    ...opponentStr,
    ...globalStr,
    ...prevMoveStr,
  ];
  return { text: fullTextList.join(" "), numbers: numerical };
}

/** Stateful v3 observation space (Expanded + TeamPreview). Call reset() per battle. */
export class V3ObservationSpace {
  anyOpponentAsleep = false;
  anyOpponentFrozen = false;
  revealedOpponents = new Set<string>();

  reset(): void {
    this.anyOpponentAsleep = false;
    this.anyOpponentFrozen = false;
    this.revealedOpponents = new Set();
  }

  stateToObs(state: UniversalState): TextNumbers {
    const obs = stateToObs(state);
    const opponent = state.opponentActivePokemon;
    this.anyOpponentAsleep = this.anyOpponentAsleep || opponent.status === "slp";
    this.anyOpponentFrozen = this.anyOpponentFrozen || opponent.status === "frz";
    obs.numbers.push(
      this.anyOpponentAsleep ? 1 : 0,
      this.anyOpponentFrozen ? 1 : 0,
      state.canTera ? 1 : 0
    );
    this.revealedOpponents.add(opponent.baseSpecies);
    const revealed = [...this.revealedOpponents].sort(pyStrCmp);
    while (revealed.length < 6) revealed.push("<blank>");
    const teampreview = [...state.opponentTeampreview].sort(pyStrCmp);
    while (teampreview.length < 6) teampreview.push("<blank>");
    obs.text =
      obs.text + " " + revealed.slice(0, 6).join(" ") + " " + teampreview.slice(0, 6).join(" ");
    return obs;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export const UNKNOWN_TOKEN = -1;

export function tokenize(text: string, vocab: Record<string, number>): number[] {
  return text.split(" ").map((w) => vocab[w] ?? UNKNOWN_TOKEN);
}

// ---------------------------------------------------------------------------
// Reward (AggressiveShapedReward)
// ---------------------------------------------------------------------------

export function aggressiveShapedReward(
  lastState: UniversalState,
  state: UniversalState
): number {
  const activeNow = state.playerActivePokemon;
  let activePrev: UPokemon | null = null;
  for (const p of [
    lastState.playerActivePokemon,
    ...lastState.availableSwitches,
  ]) {
    if (p.baseSpecies === activeNow.baseSpecies) {
      activePrev = p;
      break;
    }
  }
  const hpGain =
    activePrev === null ? 0.0 : activeNow.hpPct - activePrev.hpPct;
  const oppNow = state.opponentActivePokemon;
  const oppPrev = lastState.opponentActivePokemon;
  const damageDone =
    oppNow.baseSpecies === oppPrev.baseSpecies
      ? oppPrev.hpPct - oppNow.hpPct
      : 0.0;
  const lostPokemon =
    lastState.availableSwitches.length > state.availableSwitches.length
      ? 1.0
      : 0.0;
  const removedPokemon =
    lastState.opponentsRemaining > state.opponentsRemaining ? 1.0 : 0.0;
  const victory = state.battleWon ? 1.0 : 0.0;
  return (
    1.0 * (damageDone + hpGain) +
    2.0 * (removedPokemon - lostPokemon) +
    200.0 * victory
  );
}

// ---------------------------------------------------------------------------
// Action mapping (UniversalAction.action_idx_to_BattleOrder)
// ---------------------------------------------------------------------------

export type BattleOrderResult =
  | { kind: "move"; move: SimMove; tera: boolean }
  | { kind: "switch"; pokemon: SimPokemon }
  | null;

/**
 * Returns the set of definitely-valid action indices (0-12).
 * Mirrors definitely_valid_actions via action_idx_to_BattleOrder.
 */
export function definitelyValidActions(
  state: UniversalState,
  tracker: BattleTracker
): Set<number> {
  const maybe = maybeValidActions(state);
  const legal = new Set<number>();
  for (const a of maybe) {
    if (actionIdxToOrder(tracker, a) !== null) legal.add(a);
  }
  return legal;
}

function maybeValidActions(state: UniversalState): Set<number> {
  const legal = new Set<number>();
  if (!state.forcedSwitch) {
    const moves = state.playerActivePokemon.moves.length;
    for (let i = 0; i < moves; i++) legal.add(i);
    if (state.canTera) for (let i = 9; i < 9 + moves; i++) legal.add(i);
  }
  for (let i = 4; i < 4 + state.availableSwitches.length; i++) legal.add(i);
  return legal;
}

export function actionIdxToOrder(
  tracker: BattleTracker,
  actionIdx: number
): BattleOrderResult {
  const validMoves = new Set(tracker.availableMoves.map((m) => m.lookupName));
  let moveOptions: SimMove[];
  if (validMoves.size === 1 && validMoves.has("recharge")) {
    return { kind: "move", move: tracker.availableMoves[0], tera: false };
  } else if (validMoves.size === 1 && validMoves.has("struggle")) {
    moveOptions = [
      tracker.availableMoves[0],
      tracker.availableMoves[0],
      tracker.availableMoves[0],
      tracker.availableMoves[0],
    ];
  } else if (validMoves.has("fight")) {
    moveOptions = [
      tracker.availableMoves[0],
      tracker.availableMoves[0],
      tracker.availableMoves[0],
      tracker.availableMoves[0],
    ];
  } else {
    // stable sort of the SimMoves by official dex name, mirroring
    // consistent_move_order(list(battle.active_pokemon.moves.values()))
    // (ReplayMove.name is the official entry name, NOT the id)
    const simMoves = [...tracker.activePokemon().moves.values()];
    const order = simMoves
      .map((_, i) => i)
      .sort((a, b) => pyStrCmp(simMoves[a].name, simMoves[b].name));
    moveOptions = order.map((i) => simMoves[i]);
  }

  const validSwitches = new Set(tracker.availableSwitches.map((p) => p.nickname));
  const p1 = tracker.playerRole === "p1";
  const turn = tracker.currentTurn;
  const teamDict = turn.getTeamDict(p1);
  const activeId = tracker.activePokemon().uniqueId;
  const candidates: SimPokemon[] = [];
  for (const p of teamDict.values()) {
    const fainted = p.status === "FNT";
    if (
      tracker.reviving
        ? fainted && p.uniqueId !== activeId
        : !fainted && p.uniqueId !== activeId
    )
      candidates.push(p);
  }
  // stable sort by base_species, mirroring consistent_pokemon_order
  const upList = candidates.map(uPokemonFromSim);
  const sOrder = upList
    .map((_, i) => i)
    .sort((a, b) => pyStrCmp(upList[a].baseSpecies, upList[b].baseSpecies));
  const switchOptions = sOrder.map((i) => candidates[i]);

  let wantsTera = false;
  let idx = actionIdx;
  const canTera = tracker.canTera;
  if (idx >= 9) {
    wantsTera = true;
    idx -= 9;
  }

  if (idx <= 3 && !tracker.forceSwitch) {
    if (idx < moveOptions.length) {
      const selectedMove = moveOptions[idx];
      if (validMoves.has(selectedMove.lookupName)) {
        return {
          kind: "move",
          move: selectedMove,
          tera: wantsTera && canTera,
        };
      }
    }
  }
  if (idx >= 4 && idx <= 8) {
    const sIdx = idx - 4;
    if (sIdx < switchOptions.length) {
      const selected = switchOptions[sIdx];
      if (validSwitches.has(selected.nickname)) {
        return { kind: "switch", pokemon: selected };
      }
    }
  }
  return null;
}
