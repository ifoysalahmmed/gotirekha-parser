export interface Gps {
  satellites: number;
  lat: number;
  lon: number;
  speedKmh: number;
  course: number | null;
  gpsFixed: boolean;
  courseAcc: boolean | null;
}

export const readImei = (content: Buffer, offset: number): string => {
  const digits = content.toString('hex', offset, offset + 8).toUpperCase();

  return digits.startsWith('0') ? digits.slice(1) : digits;
};

export const readTime = (content: Buffer, offset: number): string | null => {
  const year = 2000 + content.readUInt8(offset);
  const month = content.readUInt8(offset + 1);
  const day = content.readUInt8(offset + 2);
  const hour = content.readUInt8(offset + 3);
  const minute = content.readUInt8(offset + 4);
  const second = content.readUInt8(offset + 5);

  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return date.toISOString();
};

export const readGps = (content: Buffer, offset: number): Gps => {
  const lat = content.readUInt32BE(offset + 1) / 1_800_000;
  const lon = content.readUInt32BE(offset + 5) / 1_800_000;
  const status = content.readUInt16BE(offset + 10);
  const course = status & 0x03ff;

  return {
    satellites: content.readUInt8(offset) & 0x0f,
    lat: (status & 0x0400) !== 0 ? lat : -lat,
    lon: (status & 0x0800) !== 0 ? -lon : lon,
    speedKmh: content.readUInt8(offset + 9),
    course: course < 360 ? course : course === 360 ? 0 : null,
    gpsFixed: (status & 0x1000) !== 0,
    courseAcc: (status & 0x4000) !== 0 ? (status & 0x8000) !== 0 : null,
  };
};

export const batteryPercent = (level: number): number | null =>
  level <= 6 ? Math.round((level * 100) / 6) : null;

export const gsmPercent = (level: number): number | null =>
  level <= 4 ? level * 25 : null;
