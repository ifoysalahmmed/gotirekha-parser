// Counts publishes still waiting for the queue; pauses reading at the limit and resumes at half.
export class PublishWindow {
  readonly #high: number;
  readonly #low: number;
  readonly #onPause: () => void;
  readonly #onResume: () => void;
  #inFlight = 0;
  #paused = false;

  constructor(high: number, onPause: () => void, onResume: () => void) {
    this.#high = high;
    this.#low = Math.floor(high / 2);
    this.#onPause = onPause;
    this.#onResume = onResume;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get paused(): boolean {
    return this.#paused;
  }

  begin(): void {
    this.#inFlight += 1;

    if (!this.#paused && this.#inFlight >= this.#high) {
      this.#paused = true;
      this.#onPause();
    }
  }

  end(): void {
    this.#inFlight -= 1;

    if (this.#paused && this.#inFlight <= this.#low) {
      this.#paused = false;
      this.#onResume();
    }
  }
}
