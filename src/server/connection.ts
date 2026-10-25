import type { DeviceRecord, Variant } from '@gotirekha/schemas';
import type { Socket } from 'node:net';
import type { Logger } from 'pino';
import type { Device } from '../database/registry.ts';
import { decode } from '../protocols/gt06/decode.ts';
import {
  Gt06Framer,
  type Discard,
  type Gt06Frame,
} from '../protocols/gt06/framer.ts';
import { replyFor } from '../protocols/gt06/reply.ts';
import type { PublishWindow } from '../queue/publish-window.ts';
import { messageId, type Publish } from '../queue/queue.ts';
import type { Stats } from './stats.ts';

export interface ConnectionDeps {
  port: number;
  lookup: (imei: string) => Device | undefined;
  publish: Publish;
  window: PublishWindow;
  stats: Stats;
  logger: Logger;
  onLogin: (imei: string, connection: DeviceConnection) => void;
  onClose: (connection: DeviceConnection) => void;
}

export class DeviceConnection {
  readonly peer: string;
  readonly port: number;
  readonly #socket: Socket;
  readonly #deps: ConnectionDeps;
  readonly #framer = new Gt06Framer();
  #imei: string | null = null;
  #variant: Variant | null = null;
  #closed = false;

  constructor(socket: Socket, deps: ConnectionDeps) {
    this.peer = `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? 0)}`;
    this.port = deps.port;
    this.#socket = socket;
    this.#deps = deps;

    socket.on('data', (chunk: Buffer) => {
      this.#onData(chunk);
    });

    socket.on('error', (err) => {
      deps.logger.debug(
        {
          err,
          peer: this.peer,
          imei: this.#imei,
        },
        'socket error',
      );
    });

    socket.on('close', () => {
      this.#closed = true;
      deps.onClose(this);
    });
  }

  get imei(): string | null {
    return this.#imei;
  }

  setVariant(variant: Variant | null): void {
    this.#variant = variant;
  }

  pause(): void {
    this.#socket.pause();
  }

  resume(): void {
    this.#socket.resume();
  }

  close(reason: string): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#deps.logger.info(
      {
        peer: this.peer,
        imei: this.#imei,
        reason,
      },
      'closing connection',
    );
    this.#socket.destroy();
  }

  #onData(chunk: Buffer): void {
    const receivedAt = new Date();

    for (const output of this.#framer.push(chunk)) {
      if (this.#closed) {
        return;
      }

      if (output.type === 'discard') {
        this.#onDiscard(output);
        continue;
      }

      try {
        this.#onFrame(output.frame, receivedAt);
      } catch (err) {
        this.#deps.stats.handlerErrors += 1;
        this.#deps.logger.error(
          {
            err,
            peer: this.peer,
            imei: this.#imei,
            hex: output.frame.raw.toString('hex'),
          },
          'frame handler failed',
        );
      }
    }
  }

  #onDiscard(discard: Discard): void {
    const { stats, logger } = this.#deps;

    stats.discardedBytes += discard.bytes.length;

    if (discard.reason === 'crc_mismatch') {
      stats.crcErrors += 1;
    }

    logger.debug(
      {
        peer: this.peer,
        imei: this.#imei,
        reason: discard.reason,
        hex: (discard.candidate ?? discard.bytes).toString('hex'),
      },
      'bytes discarded',
    );
  }

  #onFrame(frame: Gt06Frame, receivedAt: Date): void {
    const { stats, logger } = this.#deps;

    stats.frames += 1;

    const decoded = decode(frame, {
      imei: this.#imei,
      variant: this.#variant,
      receivedAt,
    });

    if (this.#imei === null && decoded.kind !== 'login') {
      this.close(`${decoded.kind} frame before login`);

      return;
    }

    switch (decoded.kind) {
      case 'login':
        this.#onLogin(decoded.imei, frame, receivedAt);
        break;
      case 'record':
        this.#publish(decoded.record, frame, replyFor(frame, receivedAt));
        break;
      case 'ignored':
        this.#write(replyFor(frame, receivedAt));
        break;
      case 'rejected':
        stats.rejected += 1;
        logger.info(
          {
            peer: this.peer,
            imei: this.#imei,
            reason: decoded.reason,
            detail: decoded.detail,
            hex: frame.raw.toString('hex'),
          },
          'frame rejected',
        );

        this.#write(replyFor(frame, receivedAt));
        break;
    }
  }

  #onLogin(imei: string, frame: Gt06Frame, receivedAt: Date): void {
    const { lookup, stats, logger, onLogin } = this.#deps;

    if (this.#imei !== null) {
      if (imei === this.#imei) {
        this.#write(replyFor(frame, receivedAt));
      } else {
        this.close(`second IMEI ${imei} on one connection`);
      }

      return;
    }

    const device = lookup(imei);

    if (device?.port !== this.port) {
      stats.loginsRefused += 1;
      logger.info(
        {
          peer: this.peer,
          imei,
          port: this.port,
          registeredPort: device?.port ?? null,
        },
        'login refused',
      );
      this.close(
        device === undefined
          ? 'IMEI not registered'
          : 'registered on another port',
      );

      return;
    }

    this.#imei = imei;
    this.#variant = device.variant;
    stats.logins += 1;
    onLogin(imei, this);
    this.#write(replyFor(frame, receivedAt));
  }

  #publish(record: DeviceRecord, frame: Gt06Frame, reply: Buffer | null): void {
    const { publish, window, stats, logger } = this.#deps;
    const crc = frame.raw.readUInt16BE(frame.raw.length - 4);

    window.begin();

    void publish(record, messageId(record.imei, frame.serial, crc))
      .then(() => {
        stats.published += 1;
        this.#write(reply);
      })
      .catch((err: unknown) => {
        stats.publishFailed += 1;
        logger.warn(
          {
            err,
            imei: record.imei,
            serial: frame.serial,
          },
          'publish failed, no reply sent',
        );
      })
      .finally(() => {
        window.end();
      });
  }

  #write(bytes: Buffer | null): void {
    if (bytes === null || this.#closed) {
      return;
    }

    this.#socket.write(bytes);
    this.#deps.stats.replies += 1;
  }
}
