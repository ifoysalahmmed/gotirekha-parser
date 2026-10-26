export class PreLoginGate {
  readonly #max: number;
  readonly #perIp: number;
  readonly #byIp = new Map<string, number>();
  #total = 0;

  constructor(max: number, perIp: number) {
    this.#max = max;
    this.#perIp = perIp;
  }

  get waiting(): number {
    return this.#total;
  }

  tryEnter(ip: string): boolean {
    const count = this.#byIp.get(ip) ?? 0;

    if (this.#total >= this.#max || count >= this.#perIp) {
      return false;
    }

    this.#byIp.set(ip, count + 1);
    this.#total += 1;

    return true;
  }

  leave(ip: string): void {
    const count = this.#byIp.get(ip);

    if (count === undefined) {
      return;
    }

    if (count <= 1) {
      this.#byIp.delete(ip);
    } else {
      this.#byIp.set(ip, count - 1);
    }

    this.#total -= 1;
  }
}
