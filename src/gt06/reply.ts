import { crc16X25 } from './crc.ts';
import type { Gt06Frame } from './framer.ts';

const NO_REPLY = new Set([0x12, 0x15, 0x1a, 0x21, 0x22, 0x28, 0x2c, 0x94]);

export const replyFor = (frame: Gt06Frame, now: Date): Buffer | null => {
  if (frame.protocol === 0x8a) {
    return buildFrame(0x8a, timeBytes(now), frame.serial);
  }

  if (NO_REPLY.has(frame.protocol)) {
    return null;
  }

  return buildFrame(frame.protocol, Buffer.alloc(0), frame.serial);
};

const buildFrame = (protocol: number, body: Buffer, serial: number): Buffer => {
  const length = body.length + 5;
  const frame = Buffer.alloc(length + 5);

  frame.writeUInt16BE(0x7878, 0);
  frame.writeUInt8(length, 2);
  frame.writeUInt8(protocol, 3);
  body.copy(frame, 4);
  frame.writeUInt16BE(serial, length - 1);
  frame.writeUInt16BE(crc16X25(frame, 2, length + 1), length + 1);
  frame.writeUInt16BE(0x0d0a, length + 3);

  return frame;
};

const timeBytes = (now: Date): Buffer =>
  Buffer.from([
    now.getUTCFullYear() - 2000,
    now.getUTCMonth() + 1,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  ]);
