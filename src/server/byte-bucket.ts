export class ByteBucket {
  readonly #perSecond: number;
  readonly #burst: number;
  #tokens: number;
  #updatedAt: number;

  constructor(
    perSecond: number,
    burst: number,
    now: number = performance.now(),
  ) {
    this.#perSecond = perSecond;
    this.#burst = burst;
    this.#tokens = burst;
    this.#updatedAt = now;
  }

  take(bytes: number, now: number = performance.now()): number {
    const elapsed = Math.max(0, now - this.#updatedAt);

    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + (elapsed * this.#perSecond) / 1000,
    );
    this.#updatedAt = now;
    this.#tokens -= bytes;

    if (this.#tokens >= 0) {
      return 0;
    }

    return Math.ceil((-this.#tokens * 1000) / this.#perSecond);
  }
}
