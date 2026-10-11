import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '@lakka/core';

/*
 * The sandbox's slots (NF-S4, ADR 0118). Each operation runs in a slot: a uid of its own, from
 * 61000 up, with a home directory on the sandbox's tmpfs that only it can enter. The tool host
 * is root in its container, with every capability dropped but SETUID and SETGID, so it can start
 * a runner as the slot's uid and nothing else; it cannot read or signal the slot's processes.
 * Everything that has to touch them runs as the slot's uid too:
 *
 * - the runner, under prlimit: 64 processes, 1 GiB of data, 120 s of CPU, 256 files, 64 MB
 *   per file, no core dumps. The data limit also counts memory reserved and not yet used, and
 *   Node on x86_64 reserves more at startup than 512 MB allows (ADR 0118). Process and memory
 *   limits are per uid, so one operation cannot starve another of them; the container's own
 *   limits cap them all together.
 * - the cleanup after every operation: kill -9 -1 as the uid ends every process it owns,
 *   however it was started, then its System V and POSIX IPC objects and its home are removed.
 *   A slot whose processes or files survive that is taken out of use; with none left, the tool
 *   host exits and Docker restarts the container on a fresh tmpfs.
 *
 * At startup, while no operation runs, each slot makes its own home, then /tmp and /dev/shm are
 * closed to everyone but root, so a slot can write nowhere but its home: nothing it leaves can
 * reach the next operation.
 *
 * Below root, in `pnpm dev` and tests, there are no uids to switch to: slots share this
 * process's uid, have no limits, and are cleaned up by process group. The tool host says so
 * when it starts.
 */

export const FIRST_SLOT_UID = 61_000;
export const MAX_SLOTS = 64;

/** What a runner may use; prlimit's own option names. */
export const RUNNER_LIMITS = [
  '--nproc=64',
  `--data=${1024 * 1024 * 1024}`,
  '--cpu=120',
  '--nofile=256',
  `--fsize=${64 * 1024 * 1024}`,
  '--core=0',
] as const;

/** PATH for a runner as root: the image's node, and the system's tools. */
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * As a slot's uid: end every process it owns, twice since one may fork as the first signal
 * lands, then its IPC objects, then everything in its home. Prints anything still in the home.
 */
const CLEANUP = [
  'kill -9 -1 2>/dev/null',
  'kill -9 -1 2>/dev/null',
  'ipcrm --all >/dev/null 2>&1',
  'chmod -R u+rwX "$HOME" 2>/dev/null',
  'find "$HOME" -mindepth 1 -delete 2>/dev/null',
  'chmod 700 "$HOME"',
  'find "$HOME" -mindepth 1 -print -quit',
].join('; ');

export interface Slot {
  /** The slot's uid, and gid; null below root, where slots share this process's. */
  uid: number | null;
  home: string;
}

export interface SlotPoolOptions {
  count: number;
  /** Where homes are made: /tmp in the sandbox, a temporary directory in tests. */
  root: string;
  /** Run each slot as a uid of its own, with limits. Needs root, with SETUID and SETGID. */
  switchUser: boolean;
  logger: Logger;
  /** Called when every slot has been taken out of use. */
  onExhausted?: () => void;
}

type Waiter = (slot: Slot | null) => void;

function run(
  command: string,
  args: readonly string[],
  options: { uid?: number; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: options.env,
      ...(options.uid === undefined ? {} : { uid: options.uid, gid: options.uid }),
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', () => resolve({ code: null, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** Live processes of `uid`, from /proc; a zombie is already dead and waits to be reaped. */
function liveProcessesOf(uid: number): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      const state = /^State:\s+(\S)/m.exec(status)?.[1];
      if (owner === String(uid) && state !== 'Z' && state !== 'X') pids.push(Number(entry));
    } catch {
      // Gone between listing and reading.
    }
  }
  return pids;
}

export class SlotPool {
  readonly #options: SlotPoolOptions;
  readonly #free: Slot[] = [];
  readonly #waiters: Waiter[] = [];
  #usable: number;

  constructor(options: SlotPoolOptions) {
    if (options.count < 1 || options.count > MAX_SLOTS) {
      throw new Error(`a sandbox has 1 to ${MAX_SLOTS} slots`);
    }
    this.#options = options;
    this.#usable = options.count;
  }

  get size(): number {
    return this.#options.count;
  }
  get usable(): number {
    return this.#usable;
  }
  get free(): number {
    return this.#free.length;
  }
  get waiting(): number {
    return this.#waiters.length;
  }

  #envFor(slot: Slot): NodeJS.ProcessEnv {
    return {
      PATH: this.#options.switchUser ? SANDBOX_PATH : (process.env['PATH'] ?? SANDBOX_PATH),
      HOME: slot.home,
      TMPDIR: slot.home,
      LANG: 'C.UTF-8',
    };
  }

  /**
   * Makes every slot's home. As root, each slot makes its own, so it owns it, and then /tmp and
   * /dev/shm are closed: from here a slot can write only in its home. Throws when a uid cannot
   * be switched to, as under a user namespace too small for the slots' uids.
   */
  async prepare(): Promise<void> {
    const { root, count, switchUser } = this.#options;
    for (let i = 0; i < count; i += 1) {
      const uid = switchUser ? FIRST_SLOT_UID + i : null;
      const home = join(root, `slot-${FIRST_SLOT_UID + i}`);
      if (uid === null) {
        rmSync(home, { recursive: true, force: true });
        mkdirSync(home, { recursive: true, mode: 0o700 });
      } else {
        const made = await run('mkdir', ['-m', '700', home], {
          uid,
          env: { PATH: SANDBOX_PATH },
        });
        if (made.code !== 0) {
          throw new Error(`could not start a process as uid ${uid}, or make its home`);
        }
      }
      this.#free.push({ uid, home });
    }
    if (switchUser) {
      chmodSync(root, 0o711);
      for (const shared of ['/dev/shm', '/dev/mqueue']) {
        try {
          if (existsSync(shared)) chmodSync(shared, 0o711);
        } catch {
          // Not every runtime lets its owner change these; the cleanup still removes IPC.
          this.#options.logger.warn('sandbox.shared_memory_open', { status: shared });
        }
      }
    }
  }

  /** A free slot, or null if none frees up before `signal` aborts. First come, first served. */
  acquire(signal: AbortSignal): Promise<Slot | null> {
    const slot = this.#free.shift();
    if (slot !== undefined) return Promise.resolve(slot);
    if (signal.aborted || this.#usable === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = (given) => {
        signal.removeEventListener('abort', onAbort);
        resolve(given);
      };
      const onAbort = () => {
        const at = this.#waiters.indexOf(waiter);
        if (at !== -1) this.#waiters.splice(at, 1);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  /** Starts the runner in a slot: as its uid, in its home, under its limits. */
  spawnRunner(slot: Slot, runner: readonly [string, ...string[]]): ChildProcess {
    const stdio: ['pipe', 'pipe', 'ignore'] = ['pipe', 'pipe', 'ignore'];
    if (slot.uid === null) {
      const [file, ...args] = runner;
      // Its own process group, so the cleanup can end it and whatever it started.
      return spawn(file, args, { cwd: slot.home, env: this.#envFor(slot), stdio, detached: true });
    }
    // The shell enters the home as the slot's uid, which root without DAC_OVERRIDE cannot.
    return spawn(
      'sh',
      ['-c', 'cd "$HOME" && exec "$@"', 'sh', 'prlimit', ...RUNNER_LIMITS, '--', ...runner],
      { uid: slot.uid, gid: slot.uid, env: this.#envFor(slot), stdio, detached: true },
    );
  }

  /**
   * Ends everything an operation left in its slot and empties its home, then frees the slot, or
   * takes it out of use if anything survived. `runner` is the operation's runner, if any.
   */
  async release(slot: Slot, runner: ChildProcess | null): Promise<void> {
    const clean =
      slot.uid === null
        ? await this.#cleanBelowRoot(slot, runner)
        : await this.#clean(slot.uid, slot);
    if (!clean) {
      this.#usable -= 1;
      this.#options.logger.error('sandbox.slot_quarantined', {
        slot: slot.uid,
        count: this.#usable,
      });
      if (this.#usable === 0) {
        for (const waiter of this.#waiters.splice(0)) waiter(null);
        this.#options.onExhausted?.();
      }
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#free.push(slot);
    else waiter(slot);
  }

  async #clean(uid: number, slot: Slot): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await run('sh', ['-c', CLEANUP], { uid, env: this.#envFor(slot) });
      if (result.code === 0 && result.stdout === '' && liveProcessesOf(uid).length === 0) {
        return true;
      }
      // A process mid-fork, or a killed one not yet reaped by the container's init.
      await sleep(50 * (attempt + 1));
    }
    return false;
  }

  async #cleanBelowRoot(slot: Slot, runner: ChildProcess | null): Promise<boolean> {
    if (runner?.pid !== undefined) {
      try {
        process.kill(-runner.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    try {
      rmSync(slot.home, { recursive: true, force: true });
      mkdirSync(slot.home, { recursive: true, mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }

  /** Ends every slot's processes, when the tool host stops. */
  async stopAll(running: Iterable<{ slot: Slot; runner: ChildProcess | null }>): Promise<void> {
    await Promise.all(
      [...running].map(({ slot, runner }) =>
        slot.uid === null ? this.#cleanBelowRoot(slot, runner) : this.#clean(slot.uid, slot),
      ),
    );
  }
}
