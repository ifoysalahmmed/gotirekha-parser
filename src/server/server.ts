import { createServer, type Server, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Registry } from '../database/registry.ts';
import { PublishWindow } from '../queue/publish-window.ts';
import type { Publish } from '../queue/queue.ts';
import { ByteBucket } from './byte-bucket.ts';
import { DeviceConnection } from './connection.ts';
import { PreLoginGate } from './pre-login.ts';
import { createStats, type Stats } from './stats.ts';

export interface ParserServerOptions {
  host: string;
  registry: Registry;
  publish: Publish;
  logger: Logger;
  maxPendingPublishes: number;
  loginDeadlineMs: number;
  preLoginMax: number;
  preLoginPerIp: number;
  rateBytesPerS: number;
  rateBurstBytes: number;
  idleTimeoutMs: number;
}

export class ParserServer {
  readonly stats: Stats = createStats();
  readonly #options: ParserServerOptions;
  readonly #window: PublishWindow;
  readonly #gate: PreLoginGate;
  readonly #servers: Server[] = [];
  readonly #connections = new Set<DeviceConnection>();
  readonly #byImei = new Map<string, DeviceConnection>();

  constructor(options: ParserServerOptions) {
    this.#options = options;
    this.#gate = new PreLoginGate(options.preLoginMax, options.preLoginPerIp);
    this.#window = new PublishWindow(
      options.maxPendingPublishes,
      () => {
        this.#pauseAll();
      },
      () => {
        this.#resumeAll();
      },
    );
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get onlineDevices(): number {
    return this.#byImei.size;
  }

  get pendingPublishes(): number {
    return this.#window.inFlight;
  }

  get waitingForLogin(): number {
    return this.#gate.waiting;
  }

  async listen(port: number): Promise<void> {
    const server = createServer((socket) => {
      this.#accept(socket, port);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.#options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.#servers.push(server);
  }

  applyChanges(imeis: string[]): void {
    const { registry, logger } = this.#options;

    for (const imei of imeis) {
      const connection = this.#byImei.get(imei);

      if (connection === undefined) {
        continue;
      }

      const device = registry.get(imei);

      if (device?.port !== connection.port) {
        connection.close(
          device === undefined
            ? 'device no longer registered'
            : 'model moved to another port',
        );
        continue;
      }

      connection.setVariant(device.variant);
      logger.info(
        {
          imei,
          variant: device.variant,
        },
        'variant changed',
      );
    }
  }

  async stop(graceMs: number): Promise<void> {
    const closed = Promise.all(
      this.#servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
    const deadline = Date.now() + graceMs;

    while (this.#window.inFlight > 0 && Date.now() < deadline) {
      await sleep(20);
    }

    for (const connection of this.#connections) {
      connection.close('parser shutting down');
    }

    await closed;
  }

  #accept(socket: Socket, port: number): void {
    const { registry, publish, logger } = this.#options;
    const ip = socket.remoteAddress ?? 'unknown';

    if (!this.#gate.tryEnter(ip)) {
      this.stats.preLoginRefused += 1;
      socket.destroy();

      return;
    }

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);

    const connection = new DeviceConnection(socket, {
      port,
      loginDeadlineMs: this.#options.loginDeadlineMs,
      idleTimeoutMs: this.#options.idleTimeoutMs,
      bucket: new ByteBucket(
        this.#options.rateBytesPerS,
        this.#options.rateBurstBytes,
      ),
      lookup: (imei) => registry.get(imei),
      publish,
      window: this.#window,
      stats: this.stats,
      logger,
      onLogin: (imei, conn) => {
        this.#gate.leave(ip);
        this.#register(imei, conn);
      },
      onClose: (conn) => {
        if (conn.imei === null) {
          this.#gate.leave(ip);
        }

        this.#remove(conn);
      },
    });

    this.#connections.add(connection);
    this.stats.connectionsOpened += 1;

    if (this.#window.paused) {
      connection.setWindowPaused(true);
    }
  }

  #register(imei: string, connection: DeviceConnection): void {
    const previous = this.#byImei.get(imei);

    this.#byImei.set(imei, connection);

    if (previous !== undefined && previous !== connection) {
      this.stats.takeovers += 1;
      this.#options.logger.warn(
        {
          imei,
          oldPeer: previous.peer,
          newPeer: connection.peer,
        },
        'login takeover',
      );
      previous.close('replaced by a newer login');
    }
  }

  #remove(connection: DeviceConnection): void {
    if (!this.#connections.delete(connection)) {
      return;
    }

    this.stats.connectionsClosed += 1;

    const imei = connection.imei;

    if (imei !== null && this.#byImei.get(imei) === connection) {
      this.#byImei.delete(imei);
    }
  }

  #pauseAll(): void {
    this.#options.logger.warn(
      {
        pending: this.#window.inFlight,
      },
      'publish window full, pausing all sockets',
    );

    for (const connection of this.#connections) {
      connection.setWindowPaused(true);
    }
  }

  #resumeAll(): void {
    this.#options.logger.info(
      {
        pending: this.#window.inFlight,
      },
      'publish window drained, resuming sockets',
    );

    for (const connection of this.#connections) {
      connection.setWindowPaused(false);
    }
  }
}
