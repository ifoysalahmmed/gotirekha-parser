import { IMEI } from '@gotirekha/schemas';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { crc16X25 } from '../protocols/gt06/crc.ts';
import { readImei, readTime } from '../protocols/gt06/fields.ts';
import { Gt06Framer } from '../protocols/gt06/framer.ts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7878;
const LOGIN = 0x01;
const LOCATIONS = new Set([0x12, 0x16, 0x22, 0x26]);
const REPLY_WAIT_MS = 2000;

const USAGE =
  'usage: pnpm send <file.jsonl | file.gz> [--port <port>] [--speed <N> | --burst] [--now] [--imei <imei>]';

interface Piece {
  raw: Buffer;
  frame: boolean;
}

interface Line {
  at: number;
  pieces: Piece[];
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const contentAt = (raw: Buffer): number => (raw[0] === 0x79 ? 5 : 4);

const contentLength = (raw: Buffer): number => raw.length - contentAt(raw) - 6;

const protocolOf = (raw: Buffer): number => raw.readUInt8(contentAt(raw) - 1);

const protocolName = (protocol: number): string =>
  `0x${protocol.toString(16).padStart(2, '0')}`;

const seal = (raw: Buffer): void => {
  const crcAt = raw.length - 4;

  raw.writeUInt16BE(crc16X25(raw, 2, crcAt), crcAt);
};

const isLogin = (piece: Piece): boolean =>
  piece.frame &&
  protocolOf(piece.raw) === LOGIN &&
  contentLength(piece.raw) >= 8;

const locationTime = (piece: Piece): number | null => {
  if (
    !piece.frame ||
    !LOCATIONS.has(protocolOf(piece.raw)) ||
    contentLength(piece.raw) < 6
  ) {
    return null;
  }

  const time = readTime(piece.raw, contentAt(piece.raw));

  return time === null ? null : Date.parse(time);
};

const writeTime = (raw: Buffer, at: number): void => {
  const date = new Date(at);
  const offset = contentAt(raw);

  raw.writeUInt8(date.getUTCFullYear() - 2000, offset);
  raw.writeUInt8(date.getUTCMonth() + 1, offset + 1);
  raw.writeUInt8(date.getUTCDate(), offset + 2);
  raw.writeUInt8(date.getUTCHours(), offset + 3);
  raw.writeUInt8(date.getUTCMinutes(), offset + 4);
  raw.writeUInt8(date.getUTCSeconds(), offset + 5);
  seal(raw);
};

const imeiBytes = (imei: string): Buffer | null => {
  if (imei.length > 16) {
    return null;
  }

  const bytes = Buffer.from(imei.padStart(16, '0'), 'hex');

  return readImei(bytes, 0) === imei.toUpperCase() ? bytes : null;
};

const loginFrame = (imei: Buffer): Buffer => {
  const raw = Buffer.alloc(18);

  raw.writeUInt16BE(0x7878, 0);
  raw.writeUInt8(0x0d, 2);
  raw.writeUInt8(LOGIN, 3);
  imei.copy(raw, 4);
  raw.writeUInt16BE(1, 12);
  raw.writeUInt16BE(0x0d0a, 16);
  seal(raw);

  return raw;
};

const readLines = async (
  file: string,
): Promise<{ lines: Line[]; skipped: number }> => {
  const data = await readFile(file);
  const text = (file.endsWith('.gz') ? gunzipSync(data) : data).toString(
    'utf8',
  );
  const framer = new Gt06Framer();
  const lines: Line[] = [];
  let source: string | null = null;
  let skipped = 0;

  for (const row of text.split('\n')) {
    if (row.trim() === '') {
      continue;
    }

    const line = asObject(JSON.parse(row));
    const hex = line?.hex;
    const time = line?.received ?? line?.time;
    const at = typeof time === 'string' ? Date.parse(time) : NaN;

    if (
      line === null ||
      typeof hex !== 'string' ||
      Number.isNaN(at) ||
      (line.dir !== undefined && line.dir !== 'in')
    ) {
      skipped += 1;
      continue;
    }

    if (typeof line.imei === 'string') {
      source ??= line.imei;

      if (line.imei !== source) {
        skipped += 1;
        continue;
      }
    }

    const pieces = framer.push(Buffer.from(hex, 'hex')).map((output) =>
      output.type === 'frame'
        ? {
            raw: Buffer.from(output.frame.raw),
            frame: true,
          }
        : {
            raw: Buffer.from(output.bytes),
            frame: false,
          },
    );

    if (pieces.length > 0) {
      lines.push({
        at,
        pieces,
      });
    }
  }

  return {
    lines,
    skipped,
  };
};

const open = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({
      host: HOST,
      port,
    });

    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });

const write = (socket: Socket, bytes: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.write(bytes, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      speed: { type: 'string' },
      burst: { type: 'boolean' },
      now: { type: 'boolean' },
      imei: { type: 'string' },
    },
  });
  const [file] = positionals;
  const port = Number(values.port ?? DEFAULT_PORT);
  const speed = Number(values.speed ?? 1);
  const burst = values.burst === true;

  if (
    file === undefined ||
    !Number.isInteger(port) ||
    !(speed > 0) ||
    (burst && values.speed !== undefined)
  ) {
    console.error(USAGE);
    process.exitCode = 1;

    return;
  }

  const { lines, skipped } = await readLines(file);
  const pieces = lines.flatMap((line) => line.pieces);
  const frames = pieces.filter((piece) => piece.frame);
  const logins = frames.filter(isLogin);
  const [firstLogin] = logins;
  const imei =
    values.imei !== undefined
      ? IMEI.parse(values.imei)
      : firstLogin === undefined
        ? null
        : readImei(firstLogin.raw, contentAt(firstLogin.raw));

  if (imei === null) {
    console.error('no login frame in the file: pass --imei');
    process.exitCode = 1;

    return;
  }

  const imeiRaw = imeiBytes(imei);

  if (imeiRaw === null) {
    console.error(`IMEI ${imei} does not fit a GT06 login`);
    process.exitCode = 1;

    return;
  }

  for (const login of logins) {
    imeiRaw.copy(login.raw, contentAt(login.raw));
    seal(login.raw);
  }

  let shiftMs = 0;
  let moved = 0;

  if (values.now === true) {
    const latest = pieces.reduce<number | null>((max, piece) => {
      const time = locationTime(piece);

      return time === null || (max !== null && max >= time) ? max : time;
    }, null);

    if (latest !== null) {
      shiftMs = Math.floor(Date.now() / 1000) * 1000 - latest;
    }

    for (const piece of pieces) {
      const time = locationTime(piece);

      if (time !== null) {
        writeTime(piece.raw, time + shiftMs);
        moved += 1;
      }
    }
  }

  const firstAt = lines[0]?.at ?? 0;
  const lastAt = lines.at(-1)?.at ?? firstAt;
  const durationS = burst ? 0 : Math.round((lastAt - firstAt) / speed / 1000);

  console.log(
    `sending ${String(lines.length)} lines (${String(frames.length)} frames) to ${HOST}:${String(port)} as IMEI ${imei} over about ${String(durationS)} s`,
  );

  if (values.now === true) {
    console.log(
      `location dates: ${String(moved)} moved by ${String(Math.round(shiftMs / 60_000))} min`,
    );
  }

  const socket = await open(port);
  const replyFramer = new Gt06Framer();
  const replies = new Map<string, number>();
  let sentLines = 0;

  socket.on('data', (chunk: Buffer) => {
    for (const output of replyFramer.push(chunk)) {
      if (output.type === 'frame') {
        const name = protocolName(output.frame.protocol);

        replies.set(name, (replies.get(name) ?? 0) + 1);
      }
    }
  });
  socket.on('error', (err) => {
    console.error(`connection error: ${err.message}`);
  });
  const started = performance.now();

  try {
    if (frames[0] === undefined || !isLogin(frames[0])) {
      await write(socket, loginFrame(imeiRaw));
    }

    for (const line of lines) {
      if (socket.destroyed) {
        break;
      }

      if (!burst) {
        const waitMs =
          (line.at - firstAt) / speed - (performance.now() - started);

        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }

      await write(
        socket,
        Buffer.concat(line.pieces.map((piece) => piece.raw)),
      );
      sentLines += 1;
    }
  } catch (err) {
    console.error(
      `write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!socket.destroyed) {
    await sleep(REPLY_WAIT_MS);
  }

  if (!socket.destroyed) {
    socket.end();
    await once(socket, 'close');
  }

  console.log(
    `sent ${String(sentLines)} of ${String(lines.length)} lines; ${String(skipped)} lines skipped`,
  );
  console.log(
    `replies: ${
      replies.size === 0
        ? 'none'
        : [...replies]
            .map(([name, value]) => `${name} ${String(value)}`)
            .join(', ')
    }`,
  );

  if (sentLines < lines.length) {
    console.log('the parser closed the connection early (see its log)');
    process.exitCode = 1;
  }
};

await main();
