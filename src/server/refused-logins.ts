import type { RefusedRecord } from '@gotirekha/schemas';
import { isIP } from 'node:net';
import type { Logger } from 'pino';
import type { Publish } from '../queue/queue.ts';

const REPORT_EVERY_MS = 60_000;
const MAX_ENTRIES = 10_000;

interface Entry {
  imei: string;
  port: number;
  ip: string | null;
  attempts: number;
  firstAt: Date;
  lastAt: Date;
}

export interface RefusedStats {
  unknownReported: number;
  unknownDropped: number;
}

const cleanIp = (ip: string): string | null => {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) {
    return ip.slice(7);
  }

  return isIP(ip) === 0 ? null : ip;
};

const toRecord = (entry: Entry): RefusedRecord => ({
  v: 1,
  kind: 'refused',
  imei: entry.imei,
  receivedAt: entry.lastAt.toISOString(),
  firstAt: entry.firstAt.toISOString(),
  port: entry.port,
  ip: entry.ip,
  attempts: entry.attempts,
});

const reportId = (entry: Entry): string =>
  `${entry.imei}:refused:${String(entry.port)}:${String(entry.lastAt.getTime())}`;

export class RefusedLogins {
  readonly #publish: Publish;
  readonly #logger: Logger;
  #entries = new Map<string, Entry>();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #reported = 0;
  #dropped = 0;

  constructor(publish: Publish, logger: Logger) {
    this.#publish = publish;
    this.#logger = logger;
  }

  add(imei: string, port: number, ip: string): void {
    const key = `${imei}:${String(port)}`;
    const now = new Date();
    const address = cleanIp(ip);
    const entry = this.#entries.get(key);

    if (entry !== undefined) {
      entry.attempts += 1;
      entry.lastAt = now;
      entry.ip = address ?? entry.ip;

      return;
    }

    if (this.#entries.size >= MAX_ENTRIES) {
      this.#dropped += 1;

      return;
    }

    this.#entries.set(key, {
      imei,
      port,
      ip: address,
      attempts: 1,
      firstAt: now,
      lastAt: now,
    });
  }

  start(): void {
    this.#timer = setInterval(() => {
      if (this.#running === null) {
        void this.#flush();
      }
    }, REPORT_EVERY_MS);

    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    await this.#running;
    await this.#flush();
  }

  takeStats(): RefusedStats {
    const snapshot = {
      unknownReported: this.#reported,
      unknownDropped: this.#dropped,
    };

    this.#reported = 0;
    this.#dropped = 0;

    return snapshot;
  }

  #flush(): Promise<void> {
    if (this.#entries.size === 0) {
      return Promise.resolve();
    }

    const entries = [...this.#entries.values()];

    this.#entries = new Map();
    this.#running = this.#send(entries).finally(() => {
      this.#running = null;
    });

    return this.#running;
  }

  async #send(entries: Entry[]): Promise<void> {
    for (const [index, entry] of entries.entries()) {
      try {
        await this.#publish(toRecord(entry), reportId(entry));
        this.#reported += 1;
      } catch (err) {
        const dropped = entries.length - index;

        this.#dropped += dropped;
        this.#logger.warn(
          {
            err,
            dropped,
          },
          'refused-login report failed, the rest dropped',
        );

        return;
      }
    }
  }
}
