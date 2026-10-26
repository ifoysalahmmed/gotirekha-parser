import type { DeviceRecord, Variant } from '@gotirekha/schemas';
import type { Socket } from 'node:net';
import type { Logger } from 'pino';
import type { Device } from '../database/registry.ts';
import type { FrameLine, FrameLog } from '../disk/frame-log.ts';
import { decode } from '../protocols/gt06/decode.ts';
import {
  Gt06Framer,
  type Discard,
  type Gt06Frame,
} from '../protocols/gt06/framer.ts';
import { replyFor } from '../protocols/gt06/reply.ts';
import type { PublishWindow } from '../queue/publish-window.ts';
import { messageId, type Publish } from '../queue/queue.ts';
import type { ByteBucket } from './byte-bucket.ts';
import type { Stats } from './stats.ts';

export interface ConnectionDeps {
  port: number;
  loginDeadlineMs: number;
  idleTimeoutMs: number;
  bucket: ByteBucket;
  frameLog: FrameLog;
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
  #windowPaused = false;
  #loginTimer: NodeJS.Timeout | null;
  #throttleTimer: NodeJS.Timeout | null = null;
  #preLoginChunks: Buffer[] = [];
  #closeReason: string | null = null;

  constructor(socket: Socket, deps: ConnectionDeps) {
    this.peer = `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? 0)}`;
    this.port = deps.port;
    this.#socket = socket;
    this.#deps = deps;

    this.#loginTimer = setTimeout(() => {
      deps.stats.loginDeadlines += 1;
      this.close('no login before the deadline');
    }, deps.loginDeadlineMs);

    socket.on('data', (chunk: Buffer) => {
      this.#onData(chunk);
    });

    socket.on('timeout', () => {
      this.#onIdle();
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.#closeReason ??= `socket error ${err.code ?? err.message}`;
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
      this.#clearTimers();

      if (this.#imei !== null) {
        this.#log({
          time: new Date(),
          imei: this.#imei,
          peer: this.peer,
          port: this.port,
          event: 'close',
          reason: this.#closeReason ?? 'closed by device',
        });
      }

      deps.onClose(this);
    });
  }

  get imei(): string | null {
    return this.#imei;
  }

  setVariant(variant: Variant | null): void {
    this.#variant = variant;
  }

  setWindowPaused(paused: boolean): void {
    this.#windowPaused = paused;
    this.#updateFlow();
  }

  close(reason: string): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#closeReason = reason;

    const level = this.#imei === null ? 'debug' : 'info';

    this.#deps.logger[level](
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

    if (this.#imei === null) {
      this.#preLoginChunks.push(chunk);
    } else {
      this.#log({
        time: receivedAt,
        imei: this.#imei,
        peer: this.peer,
        port: this.port,
        dir: 'in',
        hex: chunk.toString('hex'),
      });
    }

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

    if (this.#imei !== null && !this.#closed) {
      this.#take(chunk.length);
    }
  }

  #take(bytes: number): void {
    const { bucket, stats, logger } = this.#deps;
    const waitMs = bucket.take(bytes);

    if (waitMs === 0) {
      return;
    }

    stats.throttled += 1;
    logger.debug(
      {
        peer: this.peer,
        imei: this.#imei,
        waitMs,
      },
      'connection throttled',
    );

    if (this.#throttleTimer !== null) {
      clearTimeout(this.#throttleTimer);
    }

    this.#throttleTimer = setTimeout(() => {
      this.#throttleTimer = null;
      this.#updateFlow();
    }, waitMs);

    this.#updateFlow();
  }

  #updateFlow(): void {
    if (this.#closed) {
      return;
    }

    if (this.#windowPaused || this.#throttleTimer !== null) {
      this.#socket.pause();
    } else {
      this.#socket.resume();
    }
  }

  #onIdle(): void {
    if (this.#windowPaused || this.#throttleTimer !== null) {
      this.#socket.setTimeout(this.#deps.idleTimeoutMs);

      return;
    }

    this.#deps.stats.idleTimeouts += 1;
    this.close('idle timeout');
  }

  #clearTimers(): void {
    if (this.#loginTimer !== null) {
      clearTimeout(this.#loginTimer);
      this.#loginTimer = null;
    }

    if (this.#throttleTimer !== null) {
      clearTimeout(this.#throttleTimer);
      this.#throttleTimer = null;
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

    if (this.#imei === null) {
      stats.junkBeforeLogin += 1;
      this.close('junk before login');
    }
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

    if (this.#loginTimer !== null) {
      clearTimeout(this.#loginTimer);
      this.#loginTimer = null;
    }

    this.#socket.setTimeout(this.#deps.idleTimeoutMs);
    this.#imei = imei;
    this.#variant = device.variant;
    stats.logins += 1;
    onLogin(imei, this);

    const line = {
      time: receivedAt,
      imei,
      peer: this.peer,
      port: this.port,
    };

    this.#log({
      ...line,
      event: 'login',
    });
    this.#log({
      ...line,
      dir: 'in',
      hex: Buffer.concat(this.#preLoginChunks).toString('hex'),
    });
    this.#preLoginChunks = [];
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

    if (this.#imei !== null) {
      this.#log({
        time: new Date(),
        imei: this.#imei,
        peer: this.peer,
        port: this.port,
        dir: 'out',
        hex: bytes.toString('hex'),
      });
    }
  }

  #log(line: FrameLine): void {
    if (!this.#deps.frameLog.write(line)) {
      this.#deps.stats.frameLogDropped += 1;
    }
  }
}
