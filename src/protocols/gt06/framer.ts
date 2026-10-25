import { crc16X25 } from './crc.ts';

const MAX_FRAME_BYTES = 2048;

export interface Gt06Frame {
  raw: Buffer;
  protocol: number;
  content: Buffer;
  serial: number;
}

export type DiscardReason =
  | 'no_start'
  | 'bad_length'
  | 'bad_stop'
  | 'crc_mismatch';

export interface Discard {
  type: 'discard';
  reason: DiscardReason;
  bytes: Buffer;
  candidate?: Buffer;
}

export type FramerOutput = { type: 'frame'; frame: Gt06Frame } | Discard;

export class Gt06Framer {
  #pending = Buffer.alloc(0);

  get bufferedBytes(): number {
    return this.#pending.length;
  }

  push(chunk: Buffer): FramerOutput[] {
    const buf =
      this.#pending.length === 0
        ? chunk
        : Buffer.concat([this.#pending, chunk]);
    const out: FramerOutput[] = [];
    let pos = 0;

    while (pos < buf.length) {
      const start = findStart(buf, pos);

      if (start === -1) {
        const last = buf[buf.length - 1];
        const end =
          last === 0x78 || last === 0x79 ? buf.length - 1 : buf.length;

        if (end > pos) {
          out.push(discard('no_start', buf, pos, end));
        }

        pos = end;
        break;
      }

      if (start > pos) {
        out.push(discard('no_start', buf, pos, start));
      }

      pos = start;

      const headerBytes = buf[pos] === 0x79 ? 4 : 3;

      if (buf.length - pos < headerBytes) {
        break;
      }

      const length =
        headerBytes === 4 ? buf.readUInt16BE(pos + 2) : buf.readUInt8(pos + 2);
      const total = headerBytes + length + 2;

      // On any mismatch skip one byte only: a real start may sit inside this one.
      if (length < 5 || total > MAX_FRAME_BYTES) {
        out.push(discard('bad_length', buf, pos, pos + 1));
        pos += 1;
        continue;
      }

      if (buf.length - pos < total) {
        break;
      }

      if (buf.readUInt16BE(pos + total - 2) !== 0x0d0a) {
        out.push(discard('bad_stop', buf, pos, pos + 1));
        pos += 1;
        continue;
      }

      const crcAt = pos + total - 4;

      if (crc16X25(buf, pos + 2, crcAt) !== buf.readUInt16BE(crcAt)) {
        out.push({
          ...discard('crc_mismatch', buf, pos, pos + 1),
          candidate: buf.subarray(pos, pos + total),
        });
        pos += 1;
        continue;
      }

      const raw = buf.subarray(pos, pos + total);

      out.push({
        type: 'frame',
        frame: {
          raw,
          protocol: raw.readUInt8(headerBytes),
          content: raw.subarray(headerBytes + 1, total - 6),
          serial: raw.readUInt16BE(total - 6),
        },
      });

      pos += total;
    }

    this.#pending = Buffer.from(buf.subarray(pos));

    return out;
  }
}

const findStart = (buf: Buffer, from: number): number => {
  for (let i = from; i + 1 < buf.length; i++) {
    const byte = buf[i];

    if ((byte === 0x78 || byte === 0x79) && buf[i + 1] === byte) {
      return i;
    }
  }

  return -1;
};

const discard = (
  reason: DiscardReason,
  buf: Buffer,
  start: number,
  end: number,
): Discard => ({
  type: 'discard',
  reason,
  bytes: buf.subarray(start, end),
});
