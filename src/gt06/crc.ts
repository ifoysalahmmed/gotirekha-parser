export const crc16X25 = (buf: Buffer, start: number, end: number): number => {
  let crc = 0xffff;

  for (const byte of buf.subarray(start, end)) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0x8408;
      } else {
        crc >>>= 1;
      }
    }
  }

  return crc ^ 0xffff;
};
