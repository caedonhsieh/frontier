/**
 * Seeded RNG utilities. SplitMix32 matches Battle Dome's per-match seeding
 * scheme so results stay reproducible across the lab and the arena.
 */

export function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** SplitMix32 PRNG returning floats in [0, 1). */
export function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (((t = t ^ (t >>> 15)) >>> 0) / 4294967296);
  };
}

/** Derive the seed string @pkmn/sim expects from a single match seed. */
export function simSeed(seed: number): `${number},${string}` {
  const rng = splitmix32(seed);
  const word = () => Math.floor(rng() * 0x100000000);
  return `${word()},${word()},${word()},${word()}`;
}
