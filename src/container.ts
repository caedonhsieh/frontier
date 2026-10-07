/**
 * Bot container lifecycle: spawn a locked-down docker container per bot per
 * match and speak the Frontier protocol over stdio (JSON lines).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { BotMessage, Slot, WorkerMessage } from './protocol.js';

export interface ContainerOpts {
  cpus: string; // e.g. '1'
  memory: string; // e.g. '512m'
  gpu?: boolean;
  dockerBin?: string;
}

interface Waiter {
  resolve: (m: BotMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BotConnection {
  private proc: ChildProcess;
  private waiters: Waiter[] = [];
  private stderrTail = '';

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (!w) return; // unsolicited line; ignore per protocol
      clearTimeout(w.timer);
      try {
        w.resolve(JSON.parse(line) as BotMessage);
      } catch {
        w.reject(new Error(`bot sent invalid JSON: ${line.slice(0, 120)}`));
      }
    });
    proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    proc.on('exit', (code) => {
      const err = new Error(
        `bot container exited (code ${code}). stderr tail: ${this.stderrTail.slice(-500)}`
      );
      while (this.waiters.length) {
        const w = this.waiters.shift()!;
        clearTimeout(w.timer);
        w.reject(err);
      }
    });
  }

  static launch(digest: string, matchId: string, slot: Slot, opts: ContainerOpts): BotConnection {
    const args = [
      'run', '--rm', '-i',
      '--network', 'none',
      '--read-only',
      '--cpus', opts.cpus,
      '--memory', opts.memory,
      '--pids-limit', '64',
      '--name', `frontier-${matchId}-${slot}`,
      '-e', `FRONTIER_MATCH_ID=${matchId}`,
      '-e', `FRONTIER_SLOT=${slot}`,
      ...(opts.gpu ? ['--gpus', '1'] : []),
      digest,
    ];
    const proc = spawn(opts.dockerBin ?? 'docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return new BotConnection(proc);
  }

  send(msg: WorkerMessage): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  /** Resolve with the bot's next message; reject if it takes longer than timeoutMs. */
  recv(timeoutMs: number): Promise<BotMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`bot timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't let a hung bot keep the worker alive forever.
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  kill(): void {
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
