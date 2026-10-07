// String normalization — exact ports of
// metamon/backend/replay_parser/str_parsing.py
//
// NOTE: Python uses str.isalpha()/str.isalnum() (Unicode-aware). The JS
// equivalents below use Unicode property escapes to match.

export function cleanNoNumbers(s: string): string {
  return Array.from(String(s))
    .filter((ch) => /\p{L}/u.test(ch))
    .join("")
    .toLowerCase();
}

export function cleanName(s: string): string {
  return Array.from(String(s))
    .filter((ch) => /[\p{L}\p{N}]/u.test(ch))
    .join("")
    .toLowerCase();
}

export function pokemonName(s: string): string {
  return cleanName(s).trim();
}

function cleanupMoveId(moveId: string): string {
  if (moveId.startsWith("hiddenpower")) return "hiddenpower";
  if (moveId === "vicegrip") return "visegrip";
  if (moveId.startsWith("return")) return "return";
  if (moveId.startsWith("frustration")) return "frustration";
  return moveId;
}

export function moveName(s: string): string {
  return cleanupMoveId(cleanNoNumbers(s)).trim();
}

/** Showdown to_id_str equivalent */
export function idstr(s: string): string {
  return cleanName(s);
}

export function parseHpFraction(raw: string): [number, number] {
  // Showdown may suffix the denominator with g/y/r (HP bar color hints).
  const m = /(\d+)\/(\d+)(?:[gyr])?\b/.exec(raw);
  if (!m) throw new Error(`StrParsingException(parse_hp_fraction, ${raw})`);
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export function parseAbility(raw: string): string {
  const ability = raw.replace(/ability:/g, "").trim();
  if (!ability || ability.includes(":"))
    throw new Error(`StrParsingException(parse_ability, ${raw})`);
  return ability;
}

export function parseItem(raw: string): string {
  const item = raw.replace(/item:/g, "").trim();
  if (!item || item.includes(":"))
    throw new Error(`StrParsingException(parse_item, ${raw})`);
  return item;
}

function parseMonFromExtra(raw: string): string {
  const mon = raw.replace(/\[of\]\s?/g, "").trim();
  if (!raw.includes("[of]") || !mon)
    throw new Error(`StrParsingException(parse_mon_from_extra, ${raw})`);
  return mon;
}

function parseAbilityFromExtra(raw: string): string {
  const ability = raw.replace(/\[from\]\s?ability:\s?/g, "").trim();
  if (!raw.includes("[from]") || !raw.includes("ability") || !ability)
    throw new Error(`StrParsingException(parse_ability_from_extra, ${raw})`);
  return ability;
}

function parseItemFromExtra(raw: string): string {
  const item = raw.replace(/\[from\]\s?item:\s?/g, "").trim();
  if (!raw.includes("[from]") || !raw.includes("item") || !item)
    throw new Error(`StrParsingException(parse_item_from_extra, ${raw})`);
  return item;
}

function parseMoveFromExtra(raw: string): string {
  const move = raw.replace(/\[from\]\s?move:\s?/g, "").trim();
  if (!raw.includes("[from]") || !raw.includes("move") || !move)
    throw new Error(`StrParsingException(parse_move_from_extra, ${raw})`);
  return move;
}

export function parseExtra(raw: string): string {
  const parts = raw.split("[from]");
  const info = parts[parts.length - 1];
  if (!raw.includes("[from]") || !info)
    throw new Error(`StrParsingException(parse_extra, ${raw})`);
  let out = info.trim();
  if (out.startsWith("move:")) out = out.replace("move:", "").trim();
  return out;
}

/** for the misc "[from] item/ability/move [of] id: pokemon" messages */
export function parseFromEffectOf(message: string[]): {
  item: string | null;
  ability: string | null;
  move: string | null;
  ofPokemon: string | null;
} {
  let item: string | null = null;
  let ability: string | null = null;
  let move: string | null = null;
  let ofPokemon: string | null = null;
  for (const arg of message) {
    if (arg.includes("[from]")) {
      if (arg.includes("item")) item = parseItemFromExtra(arg);
      if (arg.includes("ability")) ability = parseAbilityFromExtra(arg);
      if (arg.includes("move")) move = parseMoveFromExtra(arg);
    }
    if (arg.includes("[of]")) ofPokemon = parseMonFromExtra(arg);
  }
  return { item, ability, move, ofPokemon };
}

// ---- poke-env enum from_showdown_message ports ----

import {
  EFFECT_MANUAL_CORRECTIONS,
  EFFECT_NAMES,
  FIELD_NAMES,
  SIDE_CONDITION_NAMES,
  STATUS_NAMES,
  WEATHER_NAMES,
} from "./data/enums.js";

const EFFECT_SET = new Set<string>(EFFECT_NAMES as readonly string[]);
const EFFECT_NOSPACE = new Map<string, string>();
for (const n of EFFECT_NAMES as readonly string[]) {
  if (!EFFECT_NOSPACE.has(n.replace(/_/g, "")))
    EFFECT_NOSPACE.set(n.replace(/_/g, ""), n);
}

export function effectFromMessage(message: string): string {
  let m = message.split("item: ").join("");
  m = m.split("move: ").join("");
  m = m.split("ability: ").join("");
  m = m.split(" ").join("_");
  m = m.split("-").join("_");
  m = m.toUpperCase();
  if (m in EFFECT_MANUAL_CORRECTIONS) m = EFFECT_MANUAL_CORRECTIONS[m];
  if (EFFECT_SET.has(m)) return m;
  const hit = EFFECT_NOSPACE.get(m);
  if (hit) return hit;
  return "UNKNOWN";
}

const FIELD_SET = new Set<string>(FIELD_NAMES as readonly string[]);

export function fieldFromMessage(message: string): string {
  let m = message.split("move: ").join("");
  m = m.split(" ").join("_");
  if (m.endsWith("terrain") && !m.endsWith("_terrain"))
    m = m.split("terrain").join("_terrain");
  m = m.toUpperCase();
  return FIELD_SET.has(m) ? m : "UNKNOWN";
}

const SIDE_CONDITION_SET = new Set<string>(
  SIDE_CONDITION_NAMES as readonly string[]
);
const SIDE_CONDITION_NOSPACE = new Map<string, string>();
for (const n of SIDE_CONDITION_NAMES as readonly string[]) {
  if (!SIDE_CONDITION_NOSPACE.has(n.replace(/_/g, "")))
    SIDE_CONDITION_NOSPACE.set(n.replace(/_/g, ""), n);
}

export function sideConditionFromMessage(message: string): string {
  let m = message.split("move: ").join("");
  m = m.split(" ").join("_");
  m = m.split("-").join("_");
  m = m.toUpperCase();
  if (SIDE_CONDITION_SET.has(m)) return m;
  const hit = SIDE_CONDITION_NOSPACE.get(m);
  if (hit) return hit;
  return "UNKNOWN";
}

const WEATHER_SET = new Set<string>(WEATHER_NAMES as readonly string[]);

export function weatherFromMessage(message: string): string {
  let m = message.split("move: ").join("");
  m = m.split(" ").join("_");
  m = m.split("-").join("_");
  m = m.toUpperCase();
  return WEATHER_SET.has(m) ? m : "UNKNOWN";
}

const STATUS_SET = new Set<string>(STATUS_NAMES as readonly string[]);

export function statusFromCode(code: string): string {
  const m = code.toUpperCase();
  if (!STATUS_SET.has(m)) throw new Error(`KeyError: Status[${code}]`);
  return m;
}
