// Dex lookups — mirrors metamon/backend/showdown_dex/dex.py Dex (gen 9).
import pokedexJson from "./data/pokedex.json" with { type: "json" };
import movesJson from "./data/moves.json" with { type: "json" };
import { pokemonName } from "./strutil.js";

export interface PokedexEntry {
  name: string;
  baseSpecies: string;
  types: string[];
  abilities: Record<string, string>;
  baseStats: Record<string, number>;
  requiredAbility?: string;
  requiredItem?: string;
  requiredTeraType?: string;
}

export interface MoveEntry {
  name: string;
  type: string;
  category: string;
  basePower: number;
  accuracy: number | true;
  priority: number;
  pp: number;
  charge: boolean;
}

export const POKEDEX = pokedexJson as Record<string, PokedexEntry>;
export const MOVES = movesJson as Record<string, MoveEntry>;

export class PokedexMissingEntry extends Error {}
export class MovedexMissingEntry extends Error {}

export function lookupPokedex(name: string): PokedexEntry {
  const entry = POKEDEX[pokemonName(name)];
  if (!entry) throw new PokedexMissingEntry(name);
  return entry;
}

/** Non-throwing pokedex lookup (for base_species resolution). */
export function getPokedexEntry(lookupName: string): PokedexEntry | undefined {
  return POKEDEX[lookupName];
}

/** Non-throwing moves lookup. */
export function getMoveEntry(lookupName: string): MoveEntry | undefined {
  return MOVES[lookupName];
}

/** Mirrors replay_state.Pokemon.identify_from_details */
export function identifyFromDetails(
  s: string,
  getBaseSpecies = false
): { name: string; lvl: number } {
  let name = s.split(", shiny").join(""); // chop off shiny
  name = name.replace(/,\s*tera:.*$/, ""); // chop off tera info
  name = name.replace(/,\s*[MF]$/, ""); // chop off extra gender info
  // find level (only provided when not lvl 100)
  let lvl: number;
  const lvlMatch = name.match(/, L\d{1,3}/);
  if (lvlMatch) {
    lvl = parseInt(lvlMatch[0].slice(3), 10);
    name = name.replace(lvlMatch[0], "");
  } else {
    lvl = 100;
  }
  // get the standardized name and base species from the pokedex
  let nameOut = name;
  const info = getPokedexEntry(pokemonName(name));
  if (!info) {
    if (getBaseSpecies) {
      // give it a shot i guess. if it's not in the dex,
      // the replay parser is probably going to fail later anyway.
      nameOut = nameOut.split("-")[0].trim();
    }
  } else {
    nameOut = getBaseSpecies ? info.baseSpecies : info.name;
  }
  return { name: nameOut, lvl };
}
