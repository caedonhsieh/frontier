// SimProtocol — TypeScript port of
// metamon/backend/replay_parser/forward.py SimProtocol.interpret_message
// and all _parse_* handlers (live-battle path).
import { STACKABLE_CONDITION_NAMES } from "./data/enums.js";
import { identifyFromDetails } from "./dex.js";
import { SimMove, SimPokemon, NO_ABILITY, NO_ITEM, NO_STATUS, NO_WEATHER, Boosts } from "./sim_pokemon.js";
import { Turn } from "./sim_turn.js";
import {
  cleanName,
  effectFromMessage,
  fieldFromMessage,
  moveName,
  parseAbility,
  parseExtra,
  parseFromEffectOf,
  parseHpFraction,
  sideConditionFromMessage,
  statusFromCode,
  weatherFromMessage,
} from "./strutil.js";

const IGNORES = new Set([
  "", "-anim", "askreg", "badge", "bigerror", "c", "c:", "chatmsg-raw", "-crit",
  "chat", "clearpoke", "debug", "deinit", "error", "-fieldactivate", "gametype",
  "hidelines", "-hint", "hint", "html", "-hitcount", "init", "inactive",
  "inactiveoff", "j", "J", "join", "leave", "l", "L", "message", "-message",
  "-miss", "n", "-nothing", "-notarget", "-ohko", "-prepare", "-primal", "raw",
  "rated", "request", "-resisted", "start", "-supereffective", "-singlemove",
  "seed", "sentchoice", "teampreview", "title", "tier", "t:", "upkeep", "uhtml",
  "uhtmlchange", "unlink", "-zbroken",
]);

const MOVES_THAT_SWITCH_THE_USER_OUT = new Set([
  "Baton Pass", "Chilly Reception", "Flip Turn", "Parting Shot", "Shed Tail",
  "U-turn", "Volt Switch",
]);
const MOVES_THAT_SWITCH_THE_TARGET_OUT = new Set([
  "Whirlwind", "Roar", "Dragon Tail", "Circle Throw",
]);
const FORCES_REVIVAL = new Set(["Revival Blessing"]);
const MOVE_OVERRIDE = new Set([
  "Assist", "Copycat", "Me First", "Metronome", "Mirror Move",
  "Nature Power", "Snatch", "Magic Coat",
]);
const MOVE_OVERRIDE_BUT_REVEAL_ANYWAY = new Set(["Sleep Talk"]);
const MOVE_IGNORE_ITEMS = new Set(["Custap Berry"]);
const CONSECUTIVE_MOVES = new Set([
  "Rollout", "Outrage", "Thrash", "Uproar", "Petal Dance", "Ice Ball",
]);
const GEN1_PP_ROLLOVERS = new Set(["Bind", "Wrap", "Fire Spin", "Clamp"]);
const RESTORES_PP = new Set(["Lunar Dance"]);
const RESTORES_STATUS = new Set(["Healing Wish", "Lunar Dance"]);
const MOVE_CAUSED_BY_ABILITY = new Set(["Magic Bounce", "Dancer"]);
const ABILITY_STEALS_ABILITY = new Set(["Trace"]);
const ABILITY_CAUSES_MOVE_TO_FAIL: Record<string, string> = {
  "Water Absorb": "Flip Turn",
  "Dry Skin": "Flip Turn",
  "Lightning Rod": "Volt Switch",
  "Volt Absorb": "Volt Switch",
  "Storm Drain": "Flip Turn",
};
const ITEM_APPROVED_SKIP = new Set(["Knock Off", "Recycle", "Fling", "Corrosive Gas"]);
const ITEM_UNNAMED_STOLEN = new Set(["Trick", "Switcheroo"]);
const ITEM_NAMED_STOLEN = new Set(["Thief", "Covet"]);
const ITEMS_THAT_SWITCH_THE_USER_OUT = new Set(["Eject Button", "Eject Pack"]);
const ITEMS_THAT_SWITCH_THE_ATTACKER_OUT = new Set(["Red Card"]);
const SKILL_SWAP_FAILS = new Set([
  "Wonder Guard", "Multitype", "Illusion", "Stance Change", "Schooling",
  "Comatose", "Shields Down", "Disguise", "RKS System", "Battle Bond",
  "Power Construct", "Ice Face", "Gulp Missile", "Neutralizing Gas", "As One",
  "Zero to Hero", "Commander", "Protosynthesis", "Quark Drive",
  "Orichalcum Pulse", "Hadron Engine", "Poison Puppeteer",
]);
const STACKABLE = new Set<string>(STACKABLE_CONDITION_NAMES as readonly string[]);

export class SimProtocol {
  turnlist: Turn[] = [new Turn(0)];
  gen: number;
  format: string | null = null;
  players: (string | null)[] = [null, null];
  ratings: (number | string | null)[] = [null, null];
  winner: string | null = null;
  rules: string[] = [];

  constructor(gen: number) {
    this.gen = gen;
  }

  get currTurn(): Turn {
    return this.turnlist[this.turnlist.length - 1];
  }

  getOrCreatePokemonFromDetails(
    details: string,
    pokeList: (SimPokemon | null)[]
  ): SimPokemon {
    const pokeName = identifyFromDetails(details).name;
    for (const p of pokeList) {
      if (p && p.name === pokeName) return p;
    }
    const pokeBaseName = identifyFromDetails(details, true).name;
    for (const p of pokeList) {
      if (p && p.hadName === pokeBaseName) return p;
    }
    const { name, lvl } = identifyFromDetails(details);
    const poke = new SimPokemon(name, lvl, this.gen);
    if (!pokeList.includes(null)) throw new Error(`CantIDSwitchIn(${details})`);
    pokeList[pokeList.indexOf(null)] = poke;
    return poke;
  }

  interpretMessage(message: string[]): void {
    const [name, ...data] = message;
    if (IGNORES.has(name)) return;
    switch (name) {
      case "gen": this._parseGen(data); break;
      case "tier": this.format = data[0]; break;
      case "player": this._parsePlayer(data); break;
      case "teamsize": this._parseTeamsize(data); break;
      case "turn": this._parseTurn(data); break;
      case "win": this._parseWin(data); break;
      case "choice": this._parseChoice(data); break;
      case "tie": this.winner = "TIE"; break;
      case "rule": this.rules.push(data[0]); break;
      case "poke": this._parsePoke(data); break;
      case "switch":
      case "drag": this._parseSwitchDrag(data, name); break;
      case "move": this._parseMove(data); break;
      case "-damage":
      case "-heal": this._parseDamageHeal(data, name); break;
      case "-sethp": this._parseSethp(data); break;
      case "faint": this._parseFaint(data); break;
      case "-status":
      case "-curestatus": this._parseStatusCurestatus(data, name); break;
      case "-boost":
      case "-unboost": this._parseBoostUnboost(data, name); break;
      case "-swapboost": this._parseSwapboost(data); break;
      case "swap": throw new Error(`UnimplementedMessage(${message})`);
      case "-ability": this._parseAbility(data); break;
      case "-endability": this._parseEndability(data); break;
      case "-sidestart":
      case "-sideend":
      case "-swapsideconditions": this._parseSideConditions(data, name); break;
      case "-weather": this._parseWeather(data); break;
      case "-activate": this._parseActivate(data); break;
      case "-item":
      case "-enditem": this._parseItemEnditem(data, name); break;
      case "-terastallize": this._parseTerastallize(data); break;
      case "-zpower":
      case "-mega": throw new Error(`SoftLockedGen(${this.gen})`);
      case "-transform": this._parseTransform(data); break;
      case "-fieldstart":
      case "-fieldend": this._parseFieldConditions(data, name); break;
      case "-cureteam": this._parseCureteam(data); break;
      case "-start":
      case "-end": this._parseStartEnd(data, name); break;
      case "-setboost": this._parseSetboost(data); break;
      case "-clearboost": this._parseClearboost(data); break;
      case "-clearpositiveboost": this._parseClearpositiveboost(data); break;
      case "-clearnegativeboost": this._parseClearnegativeboost(data); break;
      case "-copyboost": this._parseCopyboost(data); break;
      case "-clearallboost": this._parseClearallboost(); break;
      case "-restoreboost": this._parseRestoreboost(data); break;
      case "-invertboost": this._parseInvertboost(data); break;
      case "-mustrecharge": this._parseMustrecharge(data); break;
      case "cant": break;
      case "-immune": this._parseImmune(data); break;
      case "detailschange":
      case "-formechange": this._parseDetailschangeFormechange(data); break;
      case "replace": this._parseReplace(data); break;
      case "-burst": throw new Error(`UnimplementedMessage(${message})`);
      case "-fail": this._parseFail(data); break;
      case "-singleturn": this._parseSingleturn(data); break;
      case "-block": this._parseBlock(data); break;
      default:
        if (!(data.length > 0 && data[0].startsWith(">>>")))
          throw new Error(`UnimplementedMessage(${message})`);
    }
  }

  private _parseGen(args: string[]): void {
    this.gen = parseInt(args[0], 10);
    if (!(this.gen <= 4 || this.gen === 9))
      throw new Error(`SoftLockedGen(${this.gen})`);
    if (this.gen === 9) {
      this.currTurn.canTera1 = true;
      this.currTurn.canTera2 = true;
    }
  }

  private _parsePlayer(args: string[]): void {
    if (args.length < 2 || !args[1]) return;
    let slot: number;
    if (args[0] === "p1") slot = 0;
    else if (args[0] === "p2") slot = 1;
    else throw new Error(`RareValueError(player slot ${args[0]})`);
    this.players[slot] = cleanName(args[1]);
    this.ratings[slot] = args.length >= 4 && args[3] ? parseInt(args[3], 10) : "Unrated";
  }

  private _parseTeamsize(args: string[]): void {
    const [player, sizeStr] = args;
    const size = parseInt(sizeStr, 10);
    const team = player === "p1" ? this.currTurn.pokemon1 : this.currTurn.pokemon2;
    while (team.length > size && team.includes(null)) {
      team.splice(team.indexOf(null), 1);
    }
    if (size !== 6) throw new Error(`UnusualTeamSize(${size})`);
  }

  private _parseTurn(_args: string[]): void {
    if (this.currTurn.turnNumber === null) throw new Error("assert turn_number");
    const next = this.currTurn.createNextTurn();
    next.onEndOfTurn();
    this.turnlist.push(next);
  }

  private _parseWin(args: string[]): void {
    const winnerName = cleanName(args[0]);
    if (winnerName === this.players[0]) this.winner = "PLAYER_1";
    else if (winnerName === this.players[1]) this.winner = "PLAYER_2";
    else throw new Error(`RareValueError(Unknown winner ${winnerName})`);
  }

  private _parseChoice(args: string[]): void {
    args.forEach((playerChoice, playerIdx) => {
      if (!playerChoice) return;
      playerChoice.split(",").forEach((pokeChoice, pokeIdx) => {
        const msg = pokeChoice.split(" ");
        const command = msg[0];
        const choiceArgs = msg.slice(1).join(" ").replace(/\d+/g, "").trim();
        if (
          command === "move" &&
          choiceArgs &&
          !["recharge", "struggle", "fight"].includes(choiceArgs.toLowerCase())
        ) {
          const userPokemon = (
            playerIdx === 0 ? this.currTurn.active1 : this.currTurn.active2
          )[pokeIdx];
          const move = new SimMove(choiceArgs);
          const choice = {
            name: move.name, isSwitch: false, isNoop: false,
            user: userPokemon, target: null, isTera: false,
          };
          userPokemon!.revealMove(move);
          if (playerIdx === 0) this.currTurn.choices1[pokeIdx] = choice;
          else this.currTurn.choices2[pokeIdx] = choice;
        }
      });
    });
  }

  private _parsePoke(args: string[]): void {
    const pokeList = this.currTurn.getPokemonListFromStr(args[0]);
    if (!pokeList.includes(null)) throw new Error("UnusualTeamSize");
    const { name: pokeName, lvl } = identifyFromDetails(args[1], false);
    const newPokemon = new SimPokemon(pokeName, lvl, this.gen);
    pokeList[pokeList.indexOf(null)] = newPokemon;
    const sub = args[0].slice(0, 2);
    if (sub === "p1") this.currTurn.teampreview1.push(newPokemon.clone());
    else if (sub === "p2") this.currTurn.teampreview2.push(newPokemon.clone());
    else throw new Error(`RareValueError(Unknown player: ${sub})`);
  }

  private _parseSwitchDrag(args: string[], name: string): void {
    if (args.length < 3) throw new Error(`UnfinishedMessageException(${name})`);
    const [switchTeam, switchSlot] = this.currTurn.playerIdToActionIdx(args[0]);
    let isForceSwitch = false;
    let playerSubturn: { turn: Turn | null; action: unknown } | null = null;
    for (const subturn of this.currTurn.subturns) {
      if (subturn.team === switchTeam && subturn.slot === switchSlot) {
        isForceSwitch = true;
        playerSubturn = subturn;
      }
      if (subturn.turn === null) {
        subturn.turn = this.currTurn.createSubturn(true);
      }
    }
    const pokeList = this.currTurn.getPokemonListFromStr(args[0]);
    const activePokeList = this.currTurn.getActivePokemonFromStr(args[0]);
    const currentActive = activePokeList[switchSlot];
    if (currentActive !== null) currentActive.onSwitchOut();
    const poke = this.getOrCreatePokemonFromDetails(args[1], pokeList);
    activePokeList[switchSlot] = poke;
    const [curHp, maxHp] = parseHpFraction(args[2]);
    poke.maxHp = maxHp;
    poke.currentHp = curHp;
    if (name === "switch") {
      if (isForceSwitch) {
        (playerSubturn as { action: unknown }).action = {
          name: "Switch", user: currentActive, target: poke, isSwitch: true,
        };
      } else {
        this.currTurn.setMoveAttribute({
          s: args[0].slice(0, 3), moveName: "Switch", isNoop: false,
          isSwitch: true, user: currentActive, target: poke,
        });
      }
    }
  }

  private _parseMove(args: string[]): void {
    if (args.length < 2) throw new Error("UnfinishedMessageException(move)");
    const pokeStr = args[0].slice(0, 3);
    const pokemon = this.currTurn.getPokemonFromStr(args[0], false)!;
    const moveNameStr = args[1];
    const move = new SimMove(moveNameStr);
    let probablyRepeatMove = false;

    let targetPokemon: SimPokemon | null = null;
    let targetTeamIdx: number | null = null;
    let targetSlotIdx: number | null = null;
    if (args.length > 2) {
      targetPokemon = this.currTurn.getPokemonFromStr(args[2], false);
      if (targetPokemon) {
        [targetTeamIdx, targetSlotIdx] = this.currTurn.playerIdToActionIdx(args[2]);
      }
    }

    let extraFromMessage: string | null = null;
    for (let i = args.length - 1; i >= 0; i--) {
      if (args[i].includes("[from]")) { extraFromMessage = args[i]; break; }
    }

    if (MOVES_THAT_SWITCH_THE_USER_OUT.has(moveNameStr)) {
      const notarget = args.some((d) => d.includes("[notarget]"));
      const protected_ = targetPokemon ? targetPokemon.protected : false;
      const missed = args.some((d) => d.includes("[miss]"));
      if (!notarget && !protected_ && !missed) this.currTurn.markForcedSwitch(args[0]);
    } else if (FORCES_REVIVAL.has(moveNameStr)) {
      this.currTurn.markForcedSwitch(args[0]);
    }

    if (extraFromMessage) {
      const overrideRisk =
        CONSECUTIVE_MOVES.has(moveNameStr) ||
        move.chargeMove ||
        GEN1_PP_ROLLOVERS.has(moveNameStr);
      if (
        extraFromMessage.includes("move:") ||
        extraFromMessage.includes("ability:")
      ) {
        const { ability: isAbility, move: isMove } = parseFromEffectOf([extraFromMessage]);
        if (isMove) {
          const fromMove = extraFromMessage
            .replace(/\[from\]\s?move:\s?/g, "")
            .trim();
          if (
            !extraFromMessage.includes("[from]") ||
            !extraFromMessage.includes("move") ||
            !fromMove
          )
            throw new Error(
              `StrParsingException(parse_move_from_extra, ${extraFromMessage})`
            );
          probablyRepeatMove = fromMove.toLowerCase() === moveNameStr.toLowerCase();
          if (
            MOVE_OVERRIDE_BUT_REVEAL_ANYWAY.has(fromMove) ||
            MOVE_OVERRIDE.has(fromMove)
          ) {
            if (overrideRisk && pokemon.hadMoves.size < 4)
              throw new Error(`CalledForeignConsecutive(${args})`);
            if (MOVE_OVERRIDE_BUT_REVEAL_ANYWAY.has(fromMove))
              pokemon.revealMove(move);
            return;
          }
        } else if (isAbility) {
          if (MOVE_CAUSED_BY_ABILITY.has(isAbility)) {
            if (
              MOVES_THAT_SWITCH_THE_USER_OUT.has(moveNameStr) &&
              targetPokemon !== null &&
              targetPokemon.lastUsedMoveName === moveNameStr
            ) {
              this.currTurn.removeEmptySubturn(targetTeamIdx!, targetSlotIdx!);
            }
            return;
          } else {
            throw new Error(`UnimplementedMoveFromMoveAbility(${args})`);
          }
        }
      } else {
        const abilityOrMove = parseExtra(extraFromMessage);
        probablyRepeatMove = abilityOrMove.toLowerCase() === moveNameStr.toLowerCase();
        const probablyItem =
          abilityOrMove === pokemon.hadItem ||
          abilityOrMove === pokemon.activeItem ||
          MOVE_IGNORE_ITEMS.has(abilityOrMove);
        if (!(probablyRepeatMove || probablyItem)) {
          if (MOVE_OVERRIDE_BUT_REVEAL_ANYWAY.has(abilityOrMove) || MOVE_OVERRIDE.has(abilityOrMove)) {
            if (overrideRisk && pokemon.hadMoves.size < 4)
              throw new Error(`CalledForeignConsecutive(${args})`);
            if (MOVE_OVERRIDE_BUT_REVEAL_ANYWAY.has(abilityOrMove))
              pokemon.revealMove(move);
            return;
          }
        }
        const probablyAbility =
          !["lockedmove", "pursuit"].includes(abilityOrMove.toLowerCase()) &&
          !probablyItem &&
          !probablyRepeatMove;
        if (probablyAbility) {
          if (MOVE_CAUSED_BY_ABILITY.has(abilityOrMove)) return;
          else throw new Error(`UnimplementedMoveFromMoveAbility(${args})`);
        }
      }
    }

    const pressured =
      targetPokemon !== null &&
      targetPokemon.activeAbility === "Pressure" &&
      targetPokemon !== pokemon &&
      !args.includes("[notarget]");
    let ppUsed: number;
    if (move.chargeMove) {
      ppUsed = args.includes("[still]") ? 0 : 1 + (pressured ? 1 : 0);
    } else if (this.gen === 1) {
      if (probablyRepeatMove) ppUsed = 0;
      else if (
        GEN1_PP_ROLLOVERS.has(moveNameStr) &&
        pokemon.getPpForMoveName(moveNameStr) === 0
      ) ppUsed = -63;
      else ppUsed = 1;
    } else {
      ppUsed = 1 + (pressured ? 1 : 0);
    }

    pokemon.useMove(move, ppUsed);
    if (pokemon.transformedInto !== null) {
      pokemon.transformedInto.revealMove(move.clone());
    }
    pokemon.lastTarget = { pokemon: targetPokemon, move: moveNameStr };
    if (targetPokemon) {
      targetPokemon.lastTargetedBy = { pokemon, move: moveNameStr };
    }
    this.currTurn.setMoveAttribute({
      s: pokeStr, moveName: move.name, isNoop: false, isSwitch: false,
      user: pokemon, target: targetPokemon,
    });
  }

  private _parseDamageHeal(args: string[], name: string): void {
    if (args.length < 2 || (args.length === 2 && !args[args.length - 1]))
      throw new Error(`UnfinishedMessageException(${name})`);
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;

    if (args.length > 2) {
      const { item: foundItem, ability: foundAbility, move: foundMove, ofPokemon: foundOfPokemon } =
        parseFromEffectOf(args);
      if (foundMove) {
        if (FORCES_REVIVAL.has(foundMove)) {
          const [switchTeam, switchSlot] = this.currTurn.playerIdToActionIdx(args[0]);
          for (const subturn of this.currTurn.subturns) {
            if (subturn.team === switchTeam && subturn.slot === switchSlot) {
              if (subturn.turn === null)
                subturn.turn = this.currTurn.createSubturn(true);
              subturn.action = {
                name: "$Forced Revival$", user: null, target: pokemon,
                isSwitch: false, isNoop: false, isTera: false, isRevival: true,
              };
              break;
            }
          }
          if (pokemon.status === "FNT") pokemon.status = NO_STATUS;
        }
        if (RESTORES_PP.has(foundMove)) {
          for (const [mn, mv] of pokemon.moves) {
            mv.pp = mv.maximumPp;
            if (pokemon.hadMoves.has(mn))
              pokemon.hadMoves.get(mn)!.pp = pokemon.hadMoves.get(mn)!.maximumPp;
          }
        }
        if (RESTORES_STATUS.has(foundMove) && pokemon.status !== "FNT") {
          pokemon.status = NO_STATUS;
        }
      }
      if (foundItem) {
        if (name === "-heal") {
          const ofPokemon = pokemon;
          if (ofPokemon.activeItem !== NO_ITEM) ofPokemon.activeItem = foundItem;
          if (ofPokemon.hadItem === null) ofPokemon.hadItem = foundItem;
        } else {
          const ofPokemon = foundOfPokemon
            ? this.currTurn.getPokemonFromStr(foundOfPokemon)!
            : pokemon;
          ofPokemon.activeItem = foundItem;
          if (ofPokemon.hadItem === null) ofPokemon.hadItem = foundItem;
        }
      }
      if (foundAbility) {
        let ofPokemon: SimPokemon;
        if (name === "-heal") {
          ofPokemon = pokemon;
          this._cancelOpponentSwitchBasedOnUserAbility(pokemon, foundAbility);
        } else {
          ofPokemon = foundOfPokemon
            ? this.currTurn.getPokemonFromStr(foundOfPokemon)!
            : pokemon;
        }
        ofPokemon.revealAbility(foundAbility);
      }
    }

    if (args[1].includes("fnt") || args[1] === "0" || args[1].slice(0, 2) === "0 ") {
      pokemon.currentHp = 0;
      pokemon.status = "FNT";
    } else {
      if (!args[1].includes("/")) throw new Error(`UnfinishedMessageException(${name})`);
      const [curHp, maxHp] = parseHpFraction(args[1]);
      pokemon.currentHp = curHp;
      pokemon.maxHp = maxHp;
    }
  }

  private _parseSethp(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const [curHp, maxHp] = parseHpFraction(args[1]);
    if (pokemon.maxHp) {
      if (maxHp !== pokemon.maxHp) throw new Error("assert max_hp");
    }
    pokemon.currentHp = curHp;
  }

  private _parseFaint(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    pokemon.currentHp = 0;
    pokemon.status = "FNT";
    this.currTurn.markForcedSwitch(args[0]);
  }

  private _parseStatusCurestatus(args: string[], name: string): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const { item: foundItem, ability: foundAbility, ofPokemon: foundMon } =
      parseFromEffectOf(args);
    const status = statusFromCode(args[1]);
    if (name === "-status") {
      pokemon.status = status;
    } else if (pokemon.status === status) {
      pokemon.status = NO_STATUS;
    }
    if (foundMon && foundAbility) {
      this.currTurn.getPokemonFromStr(foundMon)!.revealAbility(foundAbility);
    }
    if (foundMon && foundItem) {
      throw new Error("ForwardException(status unimplemented)");
    }
  }

  private _parseBoostUnboost(args: string[], name: string): void {
    if (args.length < 3) throw new Error(`UnfinishedMessageException(${name})`);
    let change = parseInt(args[2], 10);
    if (name === "-unboost") change *= -1;
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    pokemon.boosts.changeWithStr(args[1], change);
  }

  private _parseSwapboost(args: string[]): void {
    const pokemon1 = this.currTurn.getPokemonFromStr(args[0])!;
    const pokemon2 = this.currTurn.getPokemonFromStr(args[1])!;
    let stats: string[];
    if (args[2].includes("[from]")) {
      if (args[2].includes("Heart Swap")) {
        stats = ["atk", "spa", "def", "spd", "spe", "accuracy", "evasion"];
      } else if (args[2].includes("Guard Swap")) {
        stats = ["def", "spd"];
      } else {
        throw new Error(`UnimplementedSwapboost(${args})`);
      }
    } else {
      stats = args[2].split(", ");
    }
    const temp = pokemon1.boosts.clone();
    for (const stat of stats) {
      pokemon1.boosts.setToWithStr(stat, pokemon2.boosts.getBoost(stat));
      pokemon2.boosts.setToWithStr(stat, temp.getBoost(stat));
    }
  }

  private _parseAbility(args: string[]): void {
    if (args.length < 2) throw new Error("UnfinishedMessageException(-ability)");
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const ability = parseAbility(args[1]);
    const { item: foundItem, ability: foundAbility, move: foundMove, ofPokemon: foundMon } =
      parseFromEffectOf(args);
    this._cancelOpponentSwitchBasedOnUserAbility(pokemon, ability);
    if (foundMon && foundAbility) {
      if (ABILITY_STEALS_ABILITY.has(foundAbility)) {
        pokemon.activeAbility = ability;
        if (pokemon.hadAbility === null) pokemon.hadAbility = foundAbility;
        this.currTurn.getPokemonFromStr(foundMon)!.revealAbility(ability);
      } else {
        throw new Error(`UnhandledFromOfAbilityLogic(${args})`);
      }
    } else if ((foundItem || foundMon || foundMove) && foundAbility) {
      throw new Error(`UnhandledFromOfAbilityLogic(${args})`);
    } else {
      pokemon.revealAbility(ability);
    }
  }

  private _parseEndability(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    pokemon.activeAbility = NO_ABILITY;
    if (args.length > 1) {
      const ability = parseAbility(args[1]);
      if (pokemon.hadAbility === null) pokemon.hadAbility = ability;
    }
  }

  private _parseSideConditions(args: string[], name: string): void {
    if (name.includes("start") || name.includes("end")) {
      const sideStr = args[0].slice(0, 2);
      let side: Map<string, number>;
      if (sideStr === "p1") side = this.currTurn.conditions1;
      else if (sideStr === "p2") side = this.currTurn.conditions2;
      else throw new Error(`RareValueError(side ${args[0]})`);
      if (args.length < 2) throw new Error(`UnfinishedMessageException(${name})`);
      const condition = sideConditionFromMessage(args[1]);
      if (name.includes("start")) {
        if (STACKABLE.has(condition)) {
          side.set(condition, (side.get(condition) ?? 0) + 1);
        } else if (!side.has(condition)) {
          side.set(condition, this.currTurn.turnNumber!);
        }
      } else {
        if (side.has(condition) && condition !== "UNKNOWN") side.delete(condition);
      }
    } else {
      const t = this.currTurn.conditions1;
      this.currTurn.conditions1 = this.currTurn.conditions2;
      this.currTurn.conditions2 = t;
    }
  }

  private _parseWeather(args: string[]): void {
    if (args[0] === "none") {
      this.currTurn.weather = NO_WEATHER;
    } else {
      this.currTurn.weather = weatherFromMessage(args[0]);
    }
    const { ability: foundAbility, ofPokemon: foundOfMon } = parseFromEffectOf(args);
    if (foundOfMon) {
      const pokemon = this.currTurn.getPokemonFromStr(foundOfMon)!;
      if (foundAbility) pokemon.revealAbility(foundAbility);
    }
  }

  private _parseActivate(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    if (args[1].startsWith("ability:")) {
      const ability = parseAbility(args[1]);
      pokemon.revealAbility(ability);
      return;
    }
    const effect = effectFromMessage(args[1]);
    const { item: foundItem, ability: foundAbility, move: foundMove, ofPokemon: foundMon } =
      parseFromEffectOf(args);
    if (effect === "TRICK") {
      if (foundMon) {
        const other = this.currTurn.getPokemonFromStr(foundMon)!;
        pokemon.tricking = other;
        other.tricking = pokemon;
      } else {
        throw new Error(`TrickError(${args})`);
      }
    } else if (effect === "MIMIC") {
      pokemon.mimic(args[2]);
    } else if (effect === "LEPPA_BERRY" || effect === "MYSTERY_BERRY") {
      const ppGained = effect === "LEPPA_BERRY" ? 10 : 5;
      const mn = args[2];
      if (pokemon.moves.has(mn)) {
        pokemon.moves.get(mn)!.pp += ppGained;
        if (pokemon.hadMoves.has(mn)) pokemon.hadMoves.get(mn)!.pp += ppGained;
      }
    } else if (
      effect === "SKILL_SWAP" &&
      pokemon.lastTarget !== null &&
      pokemon.lastTarget.pokemon !== null
    ) {
      const target = pokemon.lastTarget.pokemon;
      const targetAbility = target.activeAbility;
      const pokemonAbility = pokemon.activeAbility;
      if (
        (targetAbility !== null && SKILL_SWAP_FAILS.has(targetAbility)) ||
        (pokemonAbility !== null && SKILL_SWAP_FAILS.has(pokemonAbility))
      ) {
        throw new Error("ForwardException(Skill Swap failure)");
      }
      target.activeAbility = pokemonAbility;
      pokemon.activeAbility = targetAbility;
    }
    pokemon.startEffect(effect);
  }

  private _parseItemEnditem(args: string[], name: string): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const item = args[1];
    const { item: foundItem, ability: foundAbility, move: foundMove, ofPokemon: foundMon } =
      parseFromEffectOf(args);
    if (foundMove) {
      if (ITEM_APPROVED_SKIP.has(foundMove)) {
        // pass
      } else if (ITEM_UNNAMED_STOLEN.has(foundMove)) {
        if (!pokemon.tricking) throw new Error(`TrickError(${name})`);
        if (pokemon.tricking.hadItem === null) pokemon.tricking.hadItem = item;
      } else if (ITEM_NAMED_STOLEN.has(foundMove)) {
        const pokemonThatHadTheItem = name.includes("end")
          ? pokemon
          : this.currTurn.getPokemonFromStr(foundMon!)!;
        pokemonThatHadTheItem.activeItem = NO_ITEM;
        if (pokemonThatHadTheItem.hadItem === null)
          pokemonThatHadTheItem.hadItem = item;
        if (pokemon.hadItem === null) pokemon.hadItem = "FORCE_UNKNOWN";
      } else {
        throw new Error(`UnhandledFromMoveItemLogic(${name})`);
      }
    } else if (pokemon.hadItem === null) {
      pokemon.hadItem = item;
    }

    if (name.includes("end")) {
      pokemon.activeItem = NO_ITEM;
      if (ITEMS_THAT_SWITCH_THE_USER_OUT.has(item) && foundMove === null) {
        this.currTurn.markForcedSwitch(args[0]);
        this._cancelOpponentSwitchBasedOnUserItem(pokemon, item);
      } else if (ITEMS_THAT_SWITCH_THE_ATTACKER_OUT.has(item) && foundMon !== null) {
        const [team, slot] = this.currTurn.playerIdToActionIdx(foundMon);
        this.currTurn.removeEmptySubturn(team, slot);
      }
    } else {
      pokemon.activeItem = item;
    }
  }

  private _parseTerastallize(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const pokeStr = args[0].slice(0, 3);
    this.currTurn.setMoveAttribute({ s: pokeStr, isTera: true });
    pokemon.type = [args[1]];
    pokemon.teraType = args[1];
    const [team] = this.currTurn.playerIdToActionIdx(pokeStr);
    if (team === 1) this.currTurn.canTera1 = false;
    else this.currTurn.canTera2 = false;
  }

  private _parseTransform(args: string[]): void {
    const user = this.currTurn.getPokemonFromStr(args[0])!;
    const target = this.currTurn.getPokemonFromStr(args[1])!;
    const { ability: foundAbility } = parseFromEffectOf(args);
    if (foundAbility) user.revealAbility(foundAbility);
    user.transform(target);
  }

  private _parseFieldConditions(args: string[], name: string): void {
    const fieldCondition = fieldFromMessage(args[0]);
    if (name === "-fieldstart") {
      const { ability: foundAbility, ofPokemon: foundOfMon } = parseFromEffectOf(args);
      if (foundOfMon && foundAbility) {
        this.currTurn.getPokemonFromStr(foundOfMon)!.revealAbility(foundAbility);
      }
      if (fieldCondition.endsWith("_TERRAIN")) {
        for (const k of [...this.currTurn.battleField.keys()]) {
          if (k.endsWith("_TERRAIN")) this.currTurn.battleField.delete(k);
        }
      }
      this.currTurn.battleField.set(fieldCondition, this.currTurn.turnNumber!);
    } else {
      if (fieldCondition !== "UNKNOWN") this.currTurn.battleField.delete(fieldCondition);
    }
  }

  private _parseCureteam(args: string[]): void {
    const pokeList = this.currTurn.getPokemonListFromStr(args[0]);
    for (const poke of pokeList) {
      if (poke && poke.status !== "FNT") poke.status = NO_STATUS;
    }
  }

  private _parseStartEnd(args: string[], name: string): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const effect = effectFromMessage(args[1]);
    if (effect === "MIMIC") {
      pokemon.mimic(args[2]);
    }
    const { item: foundItem, ability: foundAbility, move: foundMove, ofPokemon: foundMon } =
      parseFromEffectOf(args.slice(2));
    if (name.includes("start")) pokemon.startEffect(effect);
    else pokemon.endEffect(effect);
    if (foundItem || foundAbility || foundMon || foundMove) {
      const ofPokemon =
        foundMon === null ? pokemon : this.currTurn.getPokemonFromStr(foundMon)!;
      if (foundAbility) ofPokemon.revealAbility(foundAbility);
    }
  }

  private _parseSetboost(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    pokemon.boosts.setToWithStr(args[1], parseInt(args[2], 10));
  }

  private _parseClearboost(args: string[]): void {
    this.currTurn.getPokemonFromStr(args[0])!.boosts = new Boosts();
  }

  private _parseClearpositiveboost(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    for (const k of ["atk", "spa", "def", "spd", "spe", "accuracy", "evasion"] as const) {
      pokemon.boosts[k] = Math.min(pokemon.boosts[k], 0);
    }
  }

  private _parseClearnegativeboost(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    for (const k of ["atk", "spa", "def", "spd", "spe", "accuracy", "evasion"] as const) {
      pokemon.boosts[k] = Math.max(pokemon.boosts[k], 0);
    }
  }

  private _parseCopyboost(args: string[]): void {
    const source = this.currTurn.getPokemonFromStr(args[0])!;
    const target = this.currTurn.getPokemonFromStr(args[1])!;
    source.boosts = target.boosts.clone();
  }

  private _parseClearallboost(): void {
    for (const active of [this.currTurn.active1, this.currTurn.active2]) {
      for (const pokemon of active) {
        if (pokemon) pokemon.boosts = new Boosts();
      }
    }
  }

  private _parseRestoreboost(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    for (const k of ["atk", "spa", "def", "spd", "spe", "accuracy", "evasion"] as const) {
      pokemon.boosts[k] = Math.max(pokemon.boosts[k], 0);
    }
  }

  private _parseInvertboost(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    for (const k of ["atk", "spa", "def", "spd", "spe", "accuracy", "evasion"] as const) {
      pokemon.boosts[k] = -pokemon.boosts[k];
    }
  }

  private _parseMustrecharge(args: string[]): void {
    this.currTurn.setMoveAttribute({
      s: args[0].slice(0, 3), moveName: "Recharge", isNoop: true,
      isSwitch: false, user: this.currTurn.getPokemonFromStr(args[0]), target: null,
    });
  }

  private _parseImmune(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const { ability: foundAbility } = parseFromEffectOf(args);
    if (foundAbility) pokemon.revealAbility(foundAbility);
    this._cancelOpponentSwitchBasedOnUserImmunity(pokemon);
  }

  private _parseDetailschangeFormechange(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    if (pokemon.hadName === null) pokemon.hadName = pokemon.name;
    const { name } = identifyFromDetails(args[1], false);
    pokemon.updatePokedexInfo(name);
    const { ability: foundAbility } = parseFromEffectOf(args);
    if (foundAbility) pokemon.revealAbility(foundAbility);
  }

  private _parseReplace(args: string[]): void {
    const [replaceTeam, replaceSlot] = this.currTurn.playerIdToActionIdx(args[0]);
    const activePokemon = this.currTurn.getActivePokemonFromStr(args[0]);
    const toReplace = activePokemon[replaceSlot]!;
    const pokeList = this.currTurn.getPokemonListFromStr(args[0]);
    const replaceWithName = identifyFromDetails(args[1], false).name;
    let replaceWith: SimPokemon | null = null;
    for (const p of pokeList) {
      if (p !== null && p.name === replaceWithName) { replaceWith = p; break; }
    }
    if (replaceWith === null || !replaceWith.name!.startsWith("Zoroark"))
      throw new Error("ZoroarkException");
    let prevTurn = this.turnlist[this.turnlist.length - 1];
    for (let i = this.turnlist.length - 1; i >= 0; i--) {
      const t = this.turnlist[i];
      const active = t.getActivePokemonFromStr(args[0]);
      // NB: Python `in` uses Pokemon.__eq__ (unique_id), not identity
      if (!active.some((p) => p !== null && p.uniqueId === toReplace.uniqueId)) {
        prevTurn = t;
        break;
      }
      prevTurn = t;
    }
    const oldVersion = (() => {
      for (const p of [...prevTurn.pokemon1, ...prevTurn.pokemon2]) {
        if (p && p.uniqueId === toReplace.uniqueId) return p.clone();
      }
      throw new Error("get_pokemon_by_uid miss");
    })();
    for (let i = 0; i < pokeList.length; i++) {
      if (pokeList[i] && pokeList[i]!.uniqueId === oldVersion.uniqueId) {
        pokeList[i] = oldVersion;
        break;
      }
    }
    replaceWith.status = toReplace.status;
    replaceWith.currentHp = toReplace.currentHp;
    replaceWith.maxHp = toReplace.maxHp;
    replaceWith.boosts = toReplace.boosts.clone();
    activePokemon[replaceSlot] = replaceWith;
    // replacements bookkeeping omitted (replay-analysis only)
    void replaceTeam;
  }

  private _parseFail(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const { item: fromItem, ability: fromAbility, ofPokemon: fromMon } =
      parseFromEffectOf(args);
    if (fromItem !== null && fromMon !== null) pokemon.revealItem(fromItem);
    if (fromAbility !== null && fromMon !== null) pokemon.revealAbility(fromAbility);
    this._cancelUserSwitchBasedOnFailure(pokemon);
    this._cancelOpponentPartingShot(
      pokemon,
      args.some((s) => s.includes("unboost"))
    );
  }

  private _parseSingleturn(args: string[]): void {
    const pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    const effect = effectFromMessage(args[1]);
    if (effect === "PROTECT") pokemon.protected = true;
  }

  private _parseBlock(args: string[]): void {
    const { ofPokemon: fromMon } = parseFromEffectOf(args);
    let pokemon: SimPokemon;
    if (fromMon) pokemon = this.currTurn.getPokemonFromStr(fromMon)!;
    else pokemon = this.currTurn.getPokemonFromStr(args[0])!;
    if (fromMon && args[1].includes("ability")) {
      const ability = parseAbility(args[1]);
      pokemon.revealAbility(ability);
      this._cancelOpponentPartingShot(pokemon, true);
    } else {
      throw new Error("ForwardException(block unimplemented)");
    }
  }

  // ---- subturn-cancellation helpers (replay bookkeeping; no obs effect) ----
  private _cancelOpponentSwitchBasedOnUserAbility(
    userPokemon: SimPokemon, basedOnAbility: string
  ): boolean {
    const currTurn = this.currTurn;
    if (
      !(basedOnAbility in ABILITY_CAUSES_MOVE_TO_FAIL) ||
      !userPokemon.lastTargetedBy
    )
      return false;
    if (
      userPokemon.lastTargetedBy.move !== ABILITY_CAUSES_MOVE_TO_FAIL[basedOnAbility]
    )
      return false;
    const subturnSlot = currTurn.pokemonToActionIdx(userPokemon.lastTargetedBy.pokemon!);
    if (!subturnSlot) return false;
    currTurn.removeEmptySubturn(subturnSlot[0], subturnSlot[1]);
    return true;
  }

  private _cancelOpponentSwitchBasedOnUserItem(
    userPokemon: SimPokemon, basedOnItem: string
  ): boolean {
    const currTurn = this.currTurn;
    const lastTargetedBy = userPokemon.lastTargetedBy;
    if (!ITEMS_THAT_SWITCH_THE_USER_OUT.has(basedOnItem) || !lastTargetedBy)
      return false;
    if (
      !lastTargetedBy.pokemon ||
      !MOVES_THAT_SWITCH_THE_USER_OUT.has(lastTargetedBy.move)
    )
      return false;
    const subturnSlot = currTurn.pokemonToActionIdx(lastTargetedBy.pokemon);
    if (!subturnSlot) return false;
    currTurn.removeEmptySubturn(subturnSlot[0], subturnSlot[1]);
    return true;
  }

  private _cancelOpponentSwitchBasedOnUserImmunity(immunePokemon: SimPokemon): boolean {
    const currTurn = this.currTurn;
    const lastTargetedBy = immunePokemon.lastTargetedBy;
    if (!lastTargetedBy) return false;
    if (!MOVES_THAT_SWITCH_THE_USER_OUT.has(lastTargetedBy.move)) return false;
    const subturnSlot = currTurn.pokemonToActionIdx(lastTargetedBy.pokemon!);
    if (!subturnSlot) return false;
    currTurn.removeEmptySubturn(subturnSlot[0], subturnSlot[1]);
    return true;
  }

  private _cancelUserSwitchBasedOnFailure(userPokemon: SimPokemon): boolean {
    const currTurn = this.currTurn;
    if (
      userPokemon.lastUsedMove !== null &&
      MOVES_THAT_SWITCH_THE_USER_OUT.has(userPokemon.lastUsedMove.name)
    ) {
      const teamSlot = currTurn.pokemonToActionIdx(userPokemon);
      if (teamSlot) {
        currTurn.removeEmptySubturn(teamSlot[0], teamSlot[1]);
        return true;
      }
    }
    return false;
  }

  private _cancelOpponentPartingShot(
    userPokemon: SimPokemon, extraCondition: boolean
  ): boolean {
    if (userPokemon.lastTargetedBy === null) return false;
    const lastTargetedBy = userPokemon.lastTargetedBy;
    if (
      this.gen >= 7 &&
      lastTargetedBy.move === "Parting Shot" &&
      extraCondition
    ) {
      const slot = this.currTurn.pokemonToActionIdx(lastTargetedBy.pokemon!);
      if (slot !== null) {
        this.currTurn.removeEmptySubturn(slot[0], slot[1]);
        return true;
      }
    }
    return false;
  }
}

