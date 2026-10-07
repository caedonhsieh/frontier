// BattleTracker — TypeScript port of metamon/env/metamon_battle.py
// (live battle: protocol messages + Showdown requests -> tracked turn).
import { SimProtocol } from "./protocol.js";
import { SimMove, SimPokemon, NO_ABILITY, NO_ITEM } from "./sim_pokemon.js";
import { moveName, statusFromCode } from "./strutil.js";

export interface ShowdownRequest {
  side: {
    name?: string;
    id?: string;
    pokemon: RequestPokemon[];
  };
  active?: RequestActive[];
  rqid?: number;
  teamPreview?: boolean;
  maxTeamSize?: number;
  wait?: boolean;
  forceSwitch?: boolean[];
}

export interface RequestPokemon {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  moves: string[];
  baseAbility: string;
  item: string;
  teraType?: string;
  reviving?: boolean;
}

export interface RequestActive {
  moves: { move: string; id: string; pp: number; disabled?: boolean }[];
  canTerastallize?: string;
  trapped?: boolean;
  maybeTrapped?: boolean;
}

export class BattleTracker {
  protocol: SimProtocol;
  playerRole: string | null = null;
  availableMoves: SimMove[] = [];
  availableSwitches: SimPokemon[] = [];
  canTera = false;
  trapped = false;
  maybeTrapped = false;
  forceSwitch = false;
  reviving = false;
  teampreview = false;
  wait = false;
  lastRequest: ShowdownRequest | null = null;
  maxTeamSize: number | null = null;
  inTeampreview = false;

  constructor(gen = 9) {
    this.protocol = new SimProtocol(gen);
  }

  get gen(): number {
    return this.protocol.gen;
  }

  /** splitMessage is the raw "|"-split line, e.g. ["", "switch", "p1a: ..."]. */
  parseMessage(splitMessage: string[]): void {
    this.protocol.interpretMessage(splitMessage.slice(1));
  }

  parseRequest(request: ShowdownRequest): void {
    this.wait = request.wait ?? false;
    const side = request.side;
    if (side.pokemon && side.pokemon.length > 0) {
      this.playerRole = side.pokemon[0].ident.slice(0, 2);
    }
    this.canTera = false;
    this.maybeTrapped = false;
    this.reviving = (side.pokemon ?? []).some((m) => !!m.reviving);
    this.trapped = false;
    this.forceSwitch = (request.forceSwitch ?? [false])[0];
    this.lastRequest = request;
    this.teampreview = request.teamPreview ?? false;
    if (this.teampreview) {
      const n = request.side.pokemon.length;
      this.maxTeamSize = request.maxTeamSize ?? n;
    }
    if ("active" in request && request.active) {
      const ar = request.active[0];
      if (ar.trapped) this.trapped = true;
      if (ar.maybeTrapped) this.maybeTrapped = true;
      if (ar.canTerastallize) this.canTera = true;
    }
    this.updateTurnFromRequest(request);
  }

  private updateTurnFromRequest(request: ShowdownRequest): void {
    this.availableMoves = [];
    this.availableSwitches = [];
    let activePokemon: SimPokemon | null = null;
    const side = request.side;
    if (side && !this.reviving) {
      activePokemon = this.updateTurnFromSideRequest(side);
    }
    const active = request.active;
    if (active && activePokemon !== null && !this.reviving) {
      this.updateTurnFromActiveRequest(active[0], activePokemon);
    }
  }

  private parseConditionFromSideRequest(
    condition: string
  ): [number | null, number | null, string | null] {
    let currentHp: number | null = null;
    let maxHp: number | null = null;
    let status: string | null = null;
    condition = condition.trim();
    const words = condition.split(" ");
    const hpPart = words[0];
    if (hpPart.includes("/")) {
      const [c, m] = hpPart.split("/");
      currentHp = parseInt(c, 10);
      maxHp = parseInt(m, 10);
    } else if (hpPart === "0") {
      currentHp = 0;
      maxHp = 0;
    }
    if (words.length === 2) {
      status = statusFromCode(words[1]);
    }
    return [currentHp, maxHp, status];
  }

  private updatePokemonFromSideRequest(
    poke: RequestPokemon,
    metamonP: SimPokemon
  ): void {
    const [currentHp, maxHp, status] = this.parseConditionFromSideRequest(
      poke.condition
    );
    if (status !== null) metamonP.status = status;
    if (currentHp !== null) metamonP.currentHp = currentHp;
    if (maxHp !== null) metamonP.maxHp = maxHp;

    if (poke.baseAbility === "noability") {
      if (metamonP.hadAbility === null) metamonP.hadAbility = NO_ABILITY;
      metamonP.activeAbility = NO_ABILITY;
    } else {
      if (metamonP.hadAbility === null) metamonP.hadAbility = poke.baseAbility;
      metamonP.activeAbility = poke.baseAbility;
    }

    const teraType = poke.teraType ?? null;
    if (teraType !== null && metamonP.teraType === null) {
      metamonP.teraType = teraType;
    }

    if (poke.item === "") {
      if (metamonP.hadItem === null) metamonP.hadItem = NO_ITEM;
      metamonP.activeItem = NO_ITEM;
    } else {
      if (metamonP.hadItem === null) metamonP.hadItem = poke.item;
      metamonP.activeItem = poke.item;
    }

    if (metamonP.hadMoves.size === 0) {
      for (const move of poke.moves) {
        metamonP.revealMove(new SimMove(move));
      }
    }
  }

  private updateTurnFromSideRequest(side: {
    pokemon: RequestPokemon[];
  }): SimPokemon | null {
    const p1 = this.playerRole === "p1";
    const turn = this.protocol.currTurn;
    let activePokemon: SimPokemon | null = null;
    const requestPokemon = side.pokemon || false;
    if (requestPokemon) {
      for (const poke of requestPokemon) {
        if (!poke) continue;
        const metamonP = this.protocol.getOrCreatePokemonFromDetails(
          poke.details,
          turn.getPokemon(p1)
        );
        // Link the request-slot identity (custom nickname, or the species
        // display name when unnicknamed) onto the tracked pokemon. Benched
        // mons never appear in |switch| protocol lines, so without this their
        // nickname stays null and every model switch order silently fails to
        // map back to a request slot in orderToChoice (degrading to a
        // move-slot-1 autoChoose).
        if (poke.ident) {
          const ci = poke.ident.indexOf(':');
          metamonP.nickname = ci >= 0 ? poke.ident.slice(ci + 1).trim() : poke.ident.trim();
        }
        this.updatePokemonFromSideRequest(poke, metamonP);
        if (poke.active) {
          activePokemon = metamonP;
        } else if (
          !this.trapped &&
          !this.reviving &&
          metamonP.status !== "FNT"
        ) {
          this.availableSwitches.push(metamonP);
        } else if (
          !this.trapped &&
          this.reviving &&
          poke.reviving &&
          metamonP.status === "FNT"
        ) {
          this.availableSwitches.push(metamonP);
        }
      }
    }
    return activePokemon;
  }

  private updateTurnFromActiveRequest(
    activeRequest: RequestActive,
    activePokemon: SimPokemon
  ): void {
    const activeMoves = activeRequest.moves;
    const knownActiveMoves = new Map<string, SimMove>();
    for (const m of activePokemon.moves.values()) {
      knownActiveMoves.set(m.lookupName, m);
    }
    let overrideActiveMoves = true;
    const availableMoves: [SimMove, boolean][] = [];
    for (const am of activeMoves) {
      const moveId = moveName(am.id);
      const disabled = am.disabled ?? false;
      let move: SimMove;
      if (knownActiveMoves.has(moveId)) {
        move = knownActiveMoves.get(moveId)!;
        move.setPp(am.pp ?? move.pp);
      } else if (
        moveId === "recharge" ||
        moveId === "struggle" ||
        moveId === "fight"
      ) {
        overrideActiveMoves = false;
        move = new SimMove(am.move);
        move.setPp(am.pp ?? move.pp);
      } else {
        move = new SimMove(am.move);
        move.setPp(am.pp ?? move.maxPp);
      }
      availableMoves.push([move, disabled]);
    }
    if (overrideActiveMoves) {
      const nm = new Map<string, SimMove>();
      for (const [m] of availableMoves) nm.set(m.name, m);
      activePokemon.moves = nm;
    }
    this.availableMoves = availableMoves
      .filter(([, disabled]) => !disabled)
      .map(([m]) => m);
  }

  // ---- accessors mirroring MetamonBattle properties used by the obs ----

  get currentTurn() {
    return this.protocol.currTurn;
  }

  activePokemon(): SimPokemon {
    const p1 = this.playerRole === "p1";
    return this.protocol.currTurn.getActivePokemon(p1)[0]!;
  }

  opponentActivePokemon(): SimPokemon {
    const p1 = this.playerRole === "p1";
    return this.protocol.currTurn.getActivePokemon(!p1)[0]!;
  }

  team(): Map<string, SimPokemon> {
    const p1 = this.playerRole === "p1";
    return this.protocol.currTurn.getTeamDict(p1);
  }

  opponentTeam(): Map<string, SimPokemon> {
    const p1 = this.playerRole === "p1";
    return this.protocol.currTurn.getTeamDict(!p1);
  }
}
