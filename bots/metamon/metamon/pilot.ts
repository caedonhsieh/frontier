/**
 * Metamon Kadabra3 pilot: per-side BattleTrackers fed with privacy-correct
 * Showdown protocol lines, observation pipeline from the parity-verified port
 * (./battle.js, ./obs.js), argmax over legal actions, mapped back to Showdown
 * choice strings.
 *
 * The ort module and session are injected so this file stays runtime-agnostic:
 * the browser passes onnxruntime-web, Node tests can pass onnxruntime-node.
 */
import {BattleTracker, type ShowdownRequest} from './battle.js';
import {
  V3ObservationSpace,
  aggressiveShapedReward,
  definitelyValidActions,
  tokenize,
  universalStateFromTracker,
  actionIdxToOrder,
  type BattleOrderResult,
  type UniversalState,
} from './obs.js';
import {moveName} from './strutil.js';
import vocabJson from './data/vocab.json' with {type: 'json'};

const VOCAB = vocabJson as Record<string, number>;

export interface TensorLike {
  data: any;
}

export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}

export interface OrtLike {
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
}

export interface Step {
  numbers: number[];
  tokens: number[];
  illegal: boolean[];
  rl2s: number[];
  t: number;
}

export type Side = 'p1' | 'p2';

const SIDES: Side[] = ['p1', 'p2'];

/** A decision that needs model inference (built by prepare, run by inferBatch). */
export interface PreparedDecision {
  side: Side;
  step: Step;
  illegal: boolean[];
  state: UniversalState;
}

/** Per-side result of a batched inference run. */
export interface InferenceResult {
  logits: number[];
  newKeyCache: Float32Array;
  newValCache: Float32Array;
}

export type PrepareOutcome =
  | {kind: 'infer'; prepared: PreparedDecision}
  | {kind: 'choice'; choice: string}
  | {kind: 'none'};

/** Model geometry (must match the exported ONNX graph). */
const N_LAYERS = 6;
const MAX_SEQ = 200;
const N_HEADS = 12;
const HEAD_DIM = 64;
const CACHE_PER_SIDE = N_LAYERS * 1 * MAX_SEQ * N_HEADS * HEAD_DIM;
const CACHE_LAYER = 1 * MAX_SEQ * N_HEADS * HEAD_DIM;

/** Fresh per-battle pilot state for both sides sharing one model session. */
export class MetamonBattle {
  /** Debug hook: fired after each accepted decision (side, step fed, logits, chosen action). */
  onDecision?: (side: Side, step: Step, logits: number[], action: number) => void;
  private trackers: Record<Side, BattleTracker> = {
    p1: new BattleTracker(),
    p2: new BattleTracker(),
  };
  private v3 = new V3ObservationSpace();
  /**
   * Per-side KV-cache state. Each side gets an independent cache so the two
   * players' histories never interleave. Caches are zero-initialized;
   * unused slots are masked by the model via seq_lens.
   * Shape: [6 layers, 1 batch, 200 max seq, 12 heads, 64 head dim].
   */
  private keyCache: Record<Side, Float32Array> = {
    p1: new Float32Array(CACHE_PER_SIDE),
    p2: new Float32Array(CACHE_PER_SIDE),
  };
  private valCache: Record<Side, Float32Array> = {
    p1: new Float32Array(CACHE_PER_SIDE),
    p2: new Float32Array(CACHE_PER_SIDE),
  };
  /** Number of steps currently cached per side (= write position = time index). */
  private seqLen: Record<Side, number> = {p1: 0, p2: 0};
  private lastStates: Record<Side, UniversalState | null> = {p1: null, p2: null};
  private prevActions: Record<Side, number | null> = {p1: null, p2: null};
  /** Legal-by-tracker actions that failed to map to a Showdown choice (should stay ~0). */
  unmappable = 0;

  constructor(
    private ort: OrtLike,
    private session: OrtSessionLike,
  ) {}

  /** Feed fresh privacy-correct protocol lines (per-side split already applied). */
  feedLines(side: Side, lines: string[]): void {
    const tr = this.trackers[side];
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      tr.parseMessage(line.split('|'));
    }
  }

  /**
   * Build a decision for `side` up to (but not including) model inference.
   * Returns 'choice' for team preview (no inference needed), 'none' when the
   * side should wait / autoChoose, or 'infer' with a PreparedDecision to be
   * passed to inferBatch (possibly batched with the other side).
   */
  prepare(side: Side, request: ShowdownRequest): PrepareOutcome {
    const tr = this.trackers[side];
    tr.parseRequest(request);
    if (request.teamPreview) return {kind: 'choice', choice: 'team 123456'};
    if (request.wait) return {kind: 'none'};

    const state = universalStateFromTracker(tr, `battle-${side}`);
    const {text, numbers} = this.v3.stateToObs(state);
    const tokens = tokenize(text, VOCAB);
    const legal = definitelyValidActions(state, tr);
    if (legal.size === 0) return {kind: 'none'};
    const illegal = Array.from({length: 13}, (_, i) => !legal.has(i));

    const rl2s: number[] = new Array(14).fill(0);
    const last = this.lastStates[side];
    const prev = this.prevActions[side];
    if (last !== null && prev !== null) {
      rl2s[0] = aggressiveShapedReward(last, state);
      rl2s[1 + prev] = 1;
    }

    const step: Step = {numbers, tokens, illegal, rl2s, t: this.seqLen[side]};
    return {kind: 'infer', prepared: {side, step, illegal, state}};
  }

  /**
   * Run one batched KV-cache inference step for 1-2 prepared decisions.
   * The model has a static batch=2 graph; a single decision is padded with a
   * zeroed slot whose output is discarded. Returns per-side results aligned
   * with the input array (caches not yet committed — finish() commits).
   */
  async inferBatch(prepared: PreparedDecision[]): Promise<InferenceResult[]> {
    if (prepared.length === 0) return [];
    if (prepared.length > 2) throw new Error(`inferBatch: at most 2 sides, got ${prepared.length}`);
    const {Tensor} = this.ort;

    const numbers = new Float32Array(2 * 1 * 55);
    const tokens = new BigInt64Array(2 * 1 * 106);
    const illegal = new Uint8Array(2 * 1 * 13);
    const rl2s = new Float32Array(2 * 1 * 14);
    const timeIdxs = new BigInt64Array(2);
    const seqLens = new Int32Array(2);
    // Batched KV cache: [6 layers, 2 batch, 200 seq, 12 heads, 64 dim].
    const keyCache = new Float32Array(2 * CACHE_PER_SIDE);
    const valCache = new Float32Array(2 * CACHE_PER_SIDE);

    prepared.forEach((p, b) => {
      numbers.set(p.step.numbers, b * 55);
      tokens.set(p.step.tokens.map(BigInt), b * 106);
      illegal.set(p.step.illegal.map((v) => (v ? 1 : 0)), b * 13);
      rl2s.set(p.step.rl2s, b * 14);
      timeIdxs[b] = BigInt(p.step.t);
      seqLens[b] = this.seqLen[p.side];
      // Interleave per-layer: dst layer l, batch b at ((l*2+b)*CACHE_LAYER).
      for (let l = 0; l < N_LAYERS; l++) {
        const src = this.keyCache[p.side].subarray(l * CACHE_LAYER, (l + 1) * CACHE_LAYER);
        keyCache.set(src, (l * 2 + b) * CACHE_LAYER);
        const srcV = this.valCache[p.side].subarray(l * CACHE_LAYER, (l + 1) * CACHE_LAYER);
        valCache.set(srcV, (l * 2 + b) * CACHE_LAYER);
      }
    });

    const feeds: Record<string, unknown> = {
      numbers: new Tensor('float32', numbers, [2, 1, 55]),
      text_tokens: new Tensor('int64', tokens, [2, 1, 106]),
      illegal_actions: new Tensor('bool', illegal, [2, 1, 13]),
      rl2s: new Tensor('float32', rl2s, [2, 1, 14]),
      time_idxs: new Tensor('int64', timeIdxs, [2, 1, 1]),
      key_cache: new Tensor('float32', keyCache, [6, 2, 200, 12, 64]),
      val_cache: new Tensor('float32', valCache, [6, 2, 200, 12, 64]),
      seq_lens: new Tensor('int32', seqLens, [2]),
    };
    const out = await this.session.run(feeds);

    const logitData = out['logits'].data as ArrayLike<number>;
    const newKeyData = out['new_key_cache'].data as ArrayLike<number>;
    const newValData = out['new_val_cache'].data as ArrayLike<number>;
    // logits shape: [2,1,13]; caches: [6,2,200,12,64].
    return prepared.map((p, b) => {
      const logits: number[] = [];
      for (let i = 0; i < 13; i++) logits.push(Number(logitData[b * 13 + i]));
      const newKeyCache = new Float32Array(CACHE_PER_SIDE);
      const newValCache = new Float32Array(CACHE_PER_SIDE);
      for (let l = 0; l < N_LAYERS; l++) {
        const o = (l * 2 + b) * CACHE_LAYER;
        for (let i = 0; i < CACHE_LAYER; i++) {
          newKeyCache[l * CACHE_LAYER + i] = Number(newKeyData[o + i]);
          newValCache[l * CACHE_LAYER + i] = Number(newValData[o + i]);
        }
      }
      return {logits, newKeyCache, newValCache};
    });
  }

  /**
   * Map a batched inference result to a Showdown choice. Commits the KV cache
   * (the fed step becomes history) iff a ranked legal action maps. Returns
   * the choice string or null when nothing mapped.
   */
  finish(prepared: PreparedDecision, result: InferenceResult): string | null {
    const {side, step, illegal, state} = prepared;
    const {logits, newKeyCache, newValCache} = result;
    const tr = this.trackers[side];

    const ranked: number[] = [];
    for (let i = 0; i < 13; i++) if (!illegal[i]) ranked.push(i);
    ranked.sort((a, b) => logits[b] - logits[a]);
    if (ranked.length === 0) return null;

    for (const a of ranked) {
      const order = actionIdxToOrder(tr, a);
      const choice = order ? orderToChoice(tr, order) : null;
      if (choice) {
        this.keyCache[side] = newKeyCache;
        this.valCache[side] = newValCache;
        this.seqLen[side]++;
        this.lastStates[side] = state;
        this.prevActions[side] = a;
        this.onDecision?.(side, step, logits, a);
        return choice;
      }
      this.unmappable++;
    }
    return null;
  }

  /**
   * Decide a choice for `side` given its request. Returns a Showdown choice
   * string ('move N [terastallize]' / 'switch N' / 'team 123456'), or null
   * when the side should wait / autoChoose.
   *
   * Single-side path (kept for tooling); the runner batches both sides via
   * prepare/inferBatch/finish.
   */
  async decide(side: Side, request: ShowdownRequest): Promise<string | null> {
    const outcome = this.prepare(side, request);
    if (outcome.kind === 'choice') return outcome.choice;
    if (outcome.kind === 'none') return null;
    const [result] = await this.inferBatch([outcome.prepared]);
    return this.finish(outcome.prepared, result);
  }
}

/** Map a BattleOrderResult to a Showdown request slot choice string. */
function orderToChoice(tr: BattleTracker, order: Exclude<BattleOrderResult, null>): string | null {
  const req = tr.lastRequest;
  if (!req) return null;
  if (order.kind === 'move') {
    const moves = req.active?.[0]?.moves ?? [];
    const want = order.move.lookupName;
    const idx = moves.findIndex((m) => moveName(m.id) === want);
    if (idx < 0) return null;
    return `move ${idx + 1}${order.tera ? ' terastallize' : ''}`;
  }
  const mons = req.side.pokemon ?? [];
  const wantNick = order.pokemon.nickname;
  const idx = mons.findIndex((p) => identNickname(p.ident) === wantNick);
  if (idx < 0) return null;
  return `switch ${idx + 1}`;
}

function identNickname(ident: string): string {
  const i = ident.indexOf(':');
  return i >= 0 ? ident.slice(i + 1).trim() : ident.trim();
}

export {SIDES};
