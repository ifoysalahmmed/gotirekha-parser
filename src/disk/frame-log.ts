import { createWriteStream } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createGzip, type Gzip } from 'node:zlib';
import type { Logger } from 'pino';

const MAX_WAITING_BYTES = 16 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FILE_NAME = /^frames-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;

interface LineBase {
  time: Date;
  imei: string;
  peer: string;
  port: number;
}

export type FrameLine = LineBase &
  (
    | {
        dir: 'in' | 'out';
        hex: string;
      }
    | {
        event: 'login';
      }
    | {
        event: 'close';
        reason: string;
      }
  );

export class FrameLog {
  readonly #dir: string;
  readonly #days: number;
  readonly #logger: Logger;
  #gzip: Gzip | null = null;
  #closed: Promise<void> = Promise.resolve();
  #day: string | null = null;
  #failed = false;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(dir: string, days: number, logger: Logger) {
    this.#dir = dir;
    this.#days = days;
    this.#logger = logger;
  }

  async start(): Promise<void> {
    await mkdir(this.#dir, {
      recursive: true,
    });
    await this.#deleteOld();

    this.#timer = setInterval(() => {
      this.#failed = false;
      void this.#deleteOld();
    }, HOUR_MS);
    this.#timer.unref();
  }

  write(line: FrameLine): boolean {
    if (this.#failed || this.#stopped) {
      return false;
    }

    try {
      const day = line.time.toISOString().slice(0, 10);

      if (day !== this.#day) {
        this.#open(day);
      }

      if (
        this.#gzip === null ||
        this.#gzip.writableLength > MAX_WAITING_BYTES
      ) {
        return false;
      }

      const { time, ...rest } = line;
      const ordered = {
        time,
        ...rest,
      };

      this.#gzip.write(`${JSON.stringify(ordered)}\n`);

      return true;
    } catch (err) {
      this.#logger.error(
        {
          err,
        },
        'frame log line failed',
      );

      return false;
    }
  }

  async close(): Promise<void> {
    this.#stopped = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    this.#gzip?.end();
    this.#gzip = null;
    this.#day = null;

    await this.#closed;
  }

  #open(day: string): void {
    this.#gzip?.end();

    const path = join(this.#dir, `frames-${day}.jsonl.gz`);
    const gzip = createGzip();
    const file = createWriteStream(path, {
      flags: 'a',
    });

    const onError = (err: Error): void => {
      if (this.#gzip === gzip) {
        this.#gzip = null;
        this.#day = null;
        this.#failed = true;
      }

      this.#logger.error(
        {
          err,
          path,
        },
        'frame log write failed, lines dropped until the next hourly check',
      );
      file.destroy();
    };

    gzip.on('error', onError);
    file.on('error', onError);
    this.#closed = new Promise((resolve) => {
      file.on('close', () => {
        resolve();
      });
    });

    gzip.pipe(file);
    this.#gzip = gzip;
    this.#day = day;
  }

  async #deleteOld(): Promise<void> {
    const cutoff = new Date(Date.now() - this.#days * DAY_MS)
      .toISOString()
      .slice(0, 10);

    try {
      for (const name of await readdir(this.#dir)) {
        const day = FILE_NAME.exec(name)?.[1];

        if (day !== undefined && day < cutoff) {
          await unlink(join(this.#dir, name));
          this.#logger.info(
            {
              name,
            },
            'old frame log deleted',
          );
        }
      }
    } catch (err) {
      this.#logger.warn(
        {
          err,
        },
        'deleting old frame logs failed',
      );
    }
  }
}
