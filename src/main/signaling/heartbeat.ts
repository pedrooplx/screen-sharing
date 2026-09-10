/**
 * Liveness tracking over a control-plane connection (docs/DESIGN.md section 7.4
 * and 9.2). One instance per connection, on each side.
 *
 * The class is timer-agnostic: the owner calls `tick()` on an interval (2 s)
 * and forwards `pong`s to `onPong()`. This keeps it trivially unit-testable
 * with fake time. `maxMissed` consecutive un-answered ticks => the peer is
 * declared dead (3 ticks ~= 6 s, matching the design's detection budget).
 */

export interface HeartbeatOptions {
  readonly maxMissed: number;
  /** send a ping frame; the number is the nonce to echo back */
  readonly sendPing: (nonce: number, sentAt: number) => void;
  /** called once, when the peer is declared dead */
  readonly onDead: () => void;
  readonly now?: () => number;
}

export class Heartbeat {
  readonly #maxMissed: number;
  readonly #sendPing: (nonce: number, sentAt: number) => void;
  readonly #onDead: () => void;
  readonly #now: () => number;

  #missed = 0;
  #outstanding: number | null = null;
  #lastPongAt = 0;
  #dead = false;
  #started = false;

  constructor(opts: HeartbeatOptions) {
    this.#maxMissed = Math.max(1, opts.maxMissed);
    this.#sendPing = opts.sendPing;
    this.#onDead = opts.onDead;
    this.#now = opts.now ?? Date.now;
  }

  start(): void {
    this.#started = true;
    this.#lastPongAt = this.#now();
    this.tick();
  }

  get dead(): boolean {
    return this.#dead;
  }

  get lastPongAt(): number {
    return this.#lastPongAt;
  }

  /** Call on the heartbeat interval. */
  tick(): void {
    if (this.#dead || !this.#started) return;

    if (this.#outstanding !== null) {
      this.#missed += 1;
      if (this.#missed >= this.#maxMissed) {
        this.#dead = true;
        this.#onDead();
        return;
      }
    }

    const nonce = (Math.random() * 0x7fffffff) | 0;
    this.#outstanding = nonce;
    this.#sendPing(nonce, this.#now());
  }

  /** Forward every received pong here. */
  onPong(nonce: number): void {
    if (this.#dead) return;
    if (nonce === this.#outstanding) {
      this.#outstanding = null;
      this.#missed = 0;
      this.#lastPongAt = this.#now();
    }
  }

  stop(): void {
    this.#started = false;
  }
}
