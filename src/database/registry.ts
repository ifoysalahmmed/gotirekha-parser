import { Variant } from '@gotirekha/schemas';
import type pg from 'pg';
import type { Logger } from 'pino';

export interface Device {
  port: number;
  variant: Variant | null;
}

export interface Port {
  port: number;
  protocol: string;
}

interface DeviceRow {
  imei: string;
  port: number;
  variant: string | null;
}

export const readPorts = async (pool: pg.Pool): Promise<Port[]> => {
  const { rows } = await pool.query<Port>(
    'select port, protocol from parser_ports order by port',
  );

  return rows;
};

export class Registry {
  readonly #pool: pg.Pool;
  readonly #logger: Logger;
  #devices = new Map<string, Device>();
  #timer: NodeJS.Timeout | null = null;
  #reloading = false;

  constructor(pool: pg.Pool, logger: Logger) {
    this.#pool = pool;
    this.#logger = logger;
  }

  get size(): number {
    return this.#devices.size;
  }

  get(imei: string): Device | undefined {
    return this.#devices.get(imei);
  }

  async load(): Promise<string[]> {
    const { rows } = await this.#pool.query<DeviceRow>(
      'select imei, port, variant from parser_devices',
    );
    const next = new Map<string, Device>();

    for (const row of rows) {
      const variant = Variant.nullable().safeParse(row.variant);

      if (!variant.success) {
        this.#logger.warn(
          {
            imei: row.imei,
            variant: row.variant,
          },
          'variant unknown to this parser, device skipped',
        );
        continue;
      }

      next.set(row.imei, {
        port: row.port,
        variant: variant.data,
      });
    }

    const changed: string[] = [];

    for (const [imei, old] of this.#devices) {
      const now = next.get(imei);

      if (now?.port !== old.port || now.variant !== old.variant) {
        changed.push(imei);
      }
    }

    this.#devices = next;

    return changed;
  }

  start(everyMs: number, onChange: (imeis: string[]) => void): void {
    this.#timer = setInterval(() => {
      void this.#reload(onChange);
    }, everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #reload(onChange: (imeis: string[]) => void): Promise<void> {
    if (this.#reloading) {
      return;
    }

    this.#reloading = true;

    let changed: string[];

    try {
      changed = await this.load();
    } catch (err) {
      this.#logger.warn(
        {
          err,
        },
        'registry reload failed, keeping the old list',
      );

      return;
    } finally {
      this.#reloading = false;
    }

    this.#logger.debug(
      {
        devices: this.#devices.size,
        changed: changed.length,
      },
      'registry reloaded',
    );

    if (changed.length > 0) {
      onChange(changed);
    }
  }
}
