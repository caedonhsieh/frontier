/**
 * Frontier adapter for the Metamon Kadabra3 neural policy.
 *
 * Speaks the Frontier container protocol on stdin/stdout; internally drives
 * the vendored Metamon pilot (../metamon/): protocol lines from the arena
 * feed the per-side BattleTracker, and each decision runs one KV-cache
 * inference step through onnxruntime-node.
 *
 * The pilot is battle-dome's, unchanged — this file is only the protocol
 * glue. Model: kadabra3 KV-cache fp16 ONNX, CPU execution provider.
 */
import { createInterface } from 'node:readline';
import * as ort from 'onnxruntime-node';
import { MetamonBattle, type Side } from '../metamon/pilot.js';
import type { ShowdownRequest } from '../metamon/battle.js';

const MODEL_PATH = process.env.MODEL_PATH ?? '/model/model.onnx';

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Adapt the Frontier observation (the sim's activeRequest, as sent by the
 * worker) to the pilot's ShowdownRequest. Mirrors battle-dome's buildRequest.
 */
function toShowdownRequest(obs: any): ShowdownRequest {
  const req: any = {
    side: {
      name: obs.side?.name,
      id: obs.side?.id,
      pokemon: obs.side?.pokemon,
    },
    rqid: obs.rqid ?? 1,
  };
  if (obs.teamPreview) req.teamPreview = true;
  if (obs.wait) req.wait = true;
  if (obs.forceSwitch) req.forceSwitch = obs.forceSwitch;
  if (obs.active) req.active = obs.active;
  return req as ShowdownRequest;
}

/** Map the pilot's Showdown choice string to a Frontier action. */
function mapChoice(choice: string | null, obs: any): string {
  if (choice) {
    const m = /^move (\d+)( terastallize)?$/.exec(choice);
    if (m) return `move ${m[1]}${m[2] ? ' tera' : ''}`;
    if (/^switch \d+$/.test(choice)) return choice;
  }
  return firstLegal(obs);
}

/** Last-resort legal move when the pilot abstains (should be rare). */
function firstLegal(obs: any): string {
  const active = obs.active?.[0];
  if (!active) return 'pass';
  const moves = active.moves ?? [];
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    if (!mv.disabled && (mv.pp ?? 1) > 0) return `move ${i + 1}`;
  }
  const team = obs.side?.pokemon ?? [];
  for (let i = 0; i < team.length; i++) {
    if (!team[i].active && team[i].condition !== '0 fnt') return `switch ${i + 1}`;
  }
  return 'pass';
}

async function main(): Promise<void> {
  let battle: MetamonBattle | null = null;
  let slot: Side = 'p1';

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }

    switch (msg.type) {
      case 'init': {
        slot = msg.slot === 'p2' ? 'p2' : 'p1';
        const session = await ort.InferenceSession.create(MODEL_PATH, {
          executionProviders: ['cpu'],
        });
        battle = new MetamonBattle(ort as any, session as any);
        send({ type: 'ready' });
        break;
      }
      case 'team_preview': {
        // The pilot always leads 1-6 (matches battle-dome behavior).
        const n = (msg.own_team ?? []).length;
        send({ type: 'lead', order: Array.from({ length: n }, (_, i) => i) });
        break;
      }
      case 'request': {
        if (!battle) throw new Error('request before init');
        battle.feedLines(slot, msg.public_log ?? []);
        const choice = await battle.decide(slot, toShowdownRequest(msg.observation));
        send({ type: 'action', action: mapChoice(choice, msg.observation) });
        break;
      }
      case 'battle_end': {
        // Flush stdout before exiting so the last action isn't lost.
        process.stdout.write('', () => process.exit(0));
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error('[metamon-adapter]', err);
  process.exit(1);
});
