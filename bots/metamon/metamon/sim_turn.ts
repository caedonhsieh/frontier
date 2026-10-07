// Turn — mirrors replay_state.Turn (live-battle subset).
import { NO_WEATHER, SimPokemon } from "./sim_pokemon.js";

export interface Action {
  name: string | null;
  isSwitch: boolean;
  isNoop: boolean;
  user: SimPokemon | null;
  target: SimPokemon | null;
  isTera: boolean;
  isRevival?: boolean;
}

export interface Subturn {
  turn: Turn | null;
  team: number;
  slot: number;
  action: Action | null;
}

export class Turn {
  pokemon1: (SimPokemon | null)[] = Array(6).fill(null);
  pokemon2: (SimPokemon | null)[] = Array(6).fill(null);
  active1: (SimPokemon | null)[] = [null, null];
  active2: (SimPokemon | null)[] = [null, null];
  moves1: (Action | null)[] = [null, null];
  choices1: (Action | null)[] = [null, null];
  moves2: (Action | null)[] = [null, null];
  choices2: (Action | null)[] = [null, null];
  weather: string = NO_WEATHER;
  battleField: Map<string, number> = new Map();
  conditions1: Map<string, number> = new Map();
  conditions2: Map<string, number> = new Map();
  turnNumber: number | null = null;
  isForceSwitch = false;
  subturns: Subturn[] = [];
  canTera1 = false;
  canTera2 = false;
  teampreview1: SimPokemon[] = [];
  teampreview2: SimPokemon[] = [];

  constructor(turnNumber: number | null = null) {
    this.turnNumber = turnNumber;
  }

  getActivePokemon(p1: boolean): (SimPokemon | null)[] {
    return p1 ? this.active1 : this.active2;
  }
  getPokemon(p1: boolean): (SimPokemon | null)[] {
    return p1 ? this.pokemon1 : this.pokemon2;
  }
  getTeamDict(p1: boolean): Map<string, SimPokemon> {
    const role = p1 ? "p1" : "p2";
    const out = new Map<string, SimPokemon>();
    for (const p of this.getPokemon(p1)) {
      if (p !== null) out.set(`${role} ${p.name}`, p);
    }
    return out;
  }
  getConditions(p1: boolean): Map<string, number> {
    return p1 ? this.conditions1 : this.conditions2;
  }
  getTeampreview(p1: boolean): SimPokemon[] {
    return p1 ? this.teampreview1 : this.teampreview2;
  }

  getPokemonFromNickname(s: string): SimPokemon | null {
    if (s === "" || s === "null") return null;
    const sideId = s.slice(1, 3);
    const nickname = s.split(":")[1].trim();
    const p1 = sideId.includes("1");
    for (const pokemon of this.getPokemon(p1)) {
      if (pokemon !== null && pokemon.nickname === nickname) return pokemon;
    }
    return null;
  }

  getPokemonListFromStr(s: string): (SimPokemon | null)[] {
    const sub = s.slice(0, 2);
    if (sub === "p1") return this.pokemon1;
    if (sub === "p2") return this.pokemon2;
    throw new Error(`RareValueError(Unknown player: ${sub})`);
  }

  getActivePokemonFromStr(s: string): (SimPokemon | null)[] {
    const sub = s.slice(0, 2);
    if (sub === "p1") return this.active1;
    if (sub === "p2") return this.active2;
    throw new Error(`RareValueError(Unknown player: ${sub})`);
  }

  getPokemonFromStr(
    showdownMsg: string,
    fallbackToNickname = true
  ): SimPokemon | null {
    if (showdownMsg === "" || showdownMsg === "null") return null;
    const sub = showdownMsg.slice(1, 3);
    let poke: SimPokemon | null;
    if (sub === "1a" || sub === "1:") poke = this.active1[0];
    else if (sub === "1b") poke = this.active1[1];
    else if (sub === "2a" || sub === "2:") poke = this.active2[0];
    else if (sub === "2b") poke = this.active2[1];
    else throw new Error(`RareValueError(Unknown player in '${showdownMsg}')`);
    if (poke === null)
      throw new Error(`RareValueError(No pokemon present in slot ${sub})`);
    if (showdownMsg.includes(":")) {
      const nickname = showdownMsg.split(":")[1].trim();
      if (poke.nickname === null) {
        poke.nickname = nickname;
      } else if (poke.nickname !== nickname && fallbackToNickname) {
        const byNickname = this.getPokemonFromNickname(showdownMsg);
        if (byNickname !== null) return byNickname;
      }
    }
    return poke;
  }

  playerIdToActionIdx(moveStr: string): [number, number] {
    const sub = moveStr.slice(1, 3);
    if (sub === "1a" || sub === "1:") return [1, 0];
    if (sub === "1b") return [1, 1];
    if (sub === "2a" || sub === "2:") return [2, 0];
    if (sub === "2b") return [2, 1];
    throw new Error(`RareValueError(Unknown player in '${moveStr}')`);
  }

  pokemonToActionIdx(pokemon: SimPokemon): [number, number] | null {
    const teams = [this.active1, this.active2];
    for (let ti = 0; ti < teams.length; ti++) {
      for (let si = 0; si < teams[ti].length; si++) {
        if (teams[ti][si] === pokemon) return [ti + 1, si];
      }
    }
    return null;
  }

  onEndOfTurn(): void {
    for (const p of [...this.pokemon1, ...this.pokemon2]) {
      if (p) p.onEndOfTurn();
    }
  }

  createNextTurn(): Turn {
    const next = this.clone();
    next.moves1 = [null, null];
    next.moves2 = [null, null];
    next.choices1 = [null, null];
    next.choices2 = [null, null];
    next.subturns = [];
    next.turnNumber = (this.turnNumber ?? 0) + 1;
    return next;
  }

  createSubturn(forceSwitch: boolean): Turn {
    const sub = this.clone();
    sub.subturns = [];
    sub.isForceSwitch = forceSwitch;
    return sub;
  }

  removeEmptySubturn(team: number, slot: number): void {
    const idx = this.subturns.findIndex(
      (st) => st.turn === null && st.team === team && st.slot === slot
    );
    if (idx >= 0) this.subturns.splice(idx, 1);
  }

  markForcedSwitch(moveStr: string): void {
    const [team, slot] = this.playerIdToActionIdx(moveStr);
    this.removeEmptySubturn(team, slot);
    this.subturns.push({ turn: null, team, slot, action: null });
  }

  setMoveAttribute(opts: {
    s: string;
    moveName?: string | null;
    isNoop?: boolean | null;
    isSwitch?: boolean | null;
    user?: SimPokemon | null;
    target?: SimPokemon | null;
    isTera?: boolean | null;
  }): void {
    const { s } = opts;
    let movesList: (Action | null)[];
    let index: number;
    if (s[1] === "1") movesList = this.moves1;
    else if (s[1] === "2") movesList = this.moves2;
    else throw new Error(`RareValueError(Unknown player: '${s}')`);
    if (s[2] === "a" || s[2] === ":") index = 0;
    else if (s[2] === "b") index = 1;
    else throw new Error(`RareValueError(Unknown index: '${s}')`);
    const cur = movesList[index];
    if (cur === null) {
      movesList[index] = {
        name: opts.moveName ?? null,
        isNoop: opts.isNoop ?? false,
        isSwitch: opts.isSwitch ?? false,
        user: opts.user ?? null,
        target: opts.target ?? null,
        isTera: opts.isTera ?? false,
      };
    } else {
      if (opts.moveName != null) cur.name = opts.moveName;
      if (opts.isSwitch != null) cur.isSwitch = opts.isSwitch;
      if (opts.user != null) cur.user = opts.user;
      if (opts.target != null) cur.target = opts.target;
      if (opts.isNoop != null) cur.isNoop = opts.isNoop;
      if (opts.isTera != null) cur.isTera = opts.isTera;
    }
  }

  /** Deep clone preserving shared references (active slots point at the
   *  cloned team members), like copy.deepcopy with memoization. */
  clone(): Turn {
    const t = new Turn(this.turnNumber);
    const remap = new Map<SimPokemon, SimPokemon>();
    const cp = (p: SimPokemon | null): SimPokemon | null => {
      if (p === null) return null;
      let c = remap.get(p);
      if (!c) {
        c = p.clone();
        // transformedInto remap (clone() leaves it null)
        remap.set(p, c);
      }
      return c;
    };
    t.pokemon1 = this.pokemon1.map(cp);
    t.pokemon2 = this.pokemon2.map(cp);
    // fix transformedInto references
    for (const [orig, c] of remap) {
      if (orig.transformedInto) {
        const tc = remap.get(orig.transformedInto);
        c.transformedInto = tc ?? orig.transformedInto.clone();
      }
      if (orig.tricking) c.tricking = remap.get(orig.tricking) ?? null;
      if (orig.lastTarget?.pokemon)
        c.lastTarget = {
          pokemon: remap.get(orig.lastTarget.pokemon) ?? null,
          move: orig.lastTarget.move,
        };
      if (orig.lastTargetedBy?.pokemon)
        c.lastTargetedBy = {
          pokemon: remap.get(orig.lastTargetedBy.pokemon) ?? null,
          move: orig.lastTargetedBy.move,
        };
    }
    t.active1 = this.active1.map(cp);
    t.active2 = this.active2.map(cp);
    t.weather = this.weather;
    t.battleField = new Map(this.battleField);
    t.conditions1 = new Map(this.conditions1);
    t.conditions2 = new Map(this.conditions2);
    t.isForceSwitch = this.isForceSwitch;
    t.canTera1 = this.canTera1;
    t.canTera2 = this.canTera2;
    t.teampreview1 = this.teampreview1.map((p) => cp(p)!);
    t.teampreview2 = this.teampreview2.map((p) => cp(p)!);
    // replay-analysis bookkeeping is not cloned deeply (no obs effect);
    // subturns/moves/choices are reset by callers that need isolation.
    t.subturns = this.subturns.map((st) => ({ ...st }));
    t.moves1 = [...this.moves1];
    t.moves2 = [...this.moves2];
    t.choices1 = [...this.choices1];
    t.choices2 = [...this.choices2];
    return t;
  }
}
