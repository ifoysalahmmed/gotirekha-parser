import { DeviceRecord, IMEI, type Variant } from '@gotirekha/schemas';
import {
  batteryPercent,
  gsmPercent,
  readGps,
  readImei,
  readTime,
} from './fields.ts';
import type { Gt06Frame } from './framer.ts';

export interface DecodeContext {
  imei: string | null;
  variant: Variant | null;
  receivedAt: Date;
}

export type RejectReason =
  | 'wrong_length'
  | 'bad_imei'
  | 'no_login'
  | 'invalid_record';

export type Decoded =
  | { kind: 'login'; imei: string }
  | { kind: 'record'; record: DeviceRecord; alarm: number | null }
  | {
      kind: 'ignored';
      reason: 'unknown_type' | 'not_used';
      alarm: number | null;
    }
  | { kind: 'rejected'; reason: RejectReason; detail: string };

interface Power {
  ignition: boolean | null;
  externalVoltage: number | null;
  batteryLevel: number | null;
  gsmSignal: number | null;
}

const NO_POWER: Power = {
  ignition: null,
  externalVoltage: null,
  batteryLevel: null,
  gsmSignal: null,
};

export const decode = (frame: Gt06Frame, ctx: DecodeContext): Decoded => {
  const { protocol, content } = frame;

  switch (protocol) {
    case 0x01:
      return login(content);
    case 0x12:
    case 0x22:
      return location(protocol, content, ctx);
    case 0x13:
      return heartbeat(content, ctx);
    case 0x16:
    case 0x26:
      return alarm(protocol, content, ctx);
    case 0x94:
      return information(content, ctx);
    case 0x19:
      return ignored(
        'not_used',
        content.length >= 12 ? content.readUInt8(11) : null,
      );
    case 0x15:
    case 0x1a:
    case 0x21:
    case 0x28:
    case 0x2c:
    case 0x8a:
      return ignored('not_used', null);
    default:
      return ignored('unknown_type', null);
  }
};

const login = (content: Buffer): Decoded => {
  if (content.length !== 8 && content.length !== 12) {
    return wrongLength(0x01, content);
  }

  const imei = readImei(content, 0);

  if (!IMEI.safeParse(imei).success) {
    return {
      kind: 'rejected',
      reason: 'bad_imei',
      detail: imei,
    };
  }

  return {
    kind: 'login',
    imei,
  };
};

const location = (
  protocol: number,
  content: Buffer,
  ctx: DecodeContext,
): Decoded => {
  if (protocol === 0x22) {
    if (content.length !== 29 && content.length !== 33) {
      return wrongLength(protocol, content);
    }

    return position(
      content,
      ctx,
      {
        ...NO_POWER,
        ignition: accByte(content.readUInt8(26)),
      },
      null,
    );
  }

  switch (ctx.variant) {
    case 's06a':
      if (content.length !== 31) {
        return wrongLength(protocol, content);
      }

      return position(content, ctx, s06aStatus(content, 26), null);
    case 's102a':
      if (content.length !== 30) {
        return wrongLength(protocol, content);
      }

      return position(content, ctx, gt06Status(content, 26), null);
    default:
      if (content.length !== 26) {
        return wrongLength(protocol, content);
      }

      return position(
        content,
        ctx,
        {
          ...NO_POWER,
          ignition: readGps(content, 6).courseAcc,
        },
        null,
      );
  }
};

const heartbeat = (content: Buffer, ctx: DecodeContext): Decoded => {
  if (content.length !== 5) {
    return wrongLength(0x13, content);
  }

  const power =
    ctx.variant === 's06a'
      ? s06aStatus(content, 0)
      : {
          ...gt06Status(content, 0),
          externalVoltage:
            ctx.variant === 'et27' ? content.readUInt8(3) / 10 : null,
        };

  return checked(
    ctx,
    {
      kind: 'status',
      ...power,
    },
    null,
  );
};

const alarm = (
  protocol: number,
  content: Buffer,
  ctx: DecodeContext,
): Decoded => {
  if (protocol === 0x16 && ctx.variant === 's06a') {
    if (content.length !== 31) {
      return wrongLength(protocol, content);
    }

    return position(content, ctx, s06aStatus(content, 26), null);
  }

  const lengths = protocol === 0x16 ? [32] : [32, 36];

  if (!lengths.includes(content.length)) {
    return wrongLength(protocol, content);
  }

  return position(content, ctx, gt06Status(content, 27), content.readUInt8(30));
};

const information = (content: Buffer, ctx: DecodeContext): Decoded => {
  if (content.length === 0) {
    return wrongLength(0x94, content);
  }

  if (content.readUInt8(0) !== 0x00) {
    return ignored('not_used', null);
  }

  if (content.length !== 3 && content.length !== 4) {
    return wrongLength(0x94, content);
  }

  return checked(
    ctx,
    {
      kind: 'status',
      ...NO_POWER,
      externalVoltage: content.readUInt16BE(1) / 100,
    },
    null,
  );
};

const position = (
  content: Buffer,
  ctx: DecodeContext,
  power: Power,
  alarmCode: number | null,
): Decoded => {
  const gps = readGps(content, 6);

  return checked(
    ctx,
    {
      kind: 'position',
      deviceTime: readTime(content, 0),
      lat: gps.lat,
      lon: gps.lon,
      speedKmh: gps.speedKmh,
      course: gps.course,
      satellites: gps.satellites,
      gpsFixed: gps.gpsFixed,
      ...power,
    },
    alarmCode,
  );
};

const gt06Status = (content: Buffer, offset: number): Power => ({
  ignition: (content.readUInt8(offset) & 0x02) !== 0,
  externalVoltage: null,
  batteryLevel: batteryPercent(content.readUInt8(offset + 1)),
  gsmSignal: gsmPercent(content.readUInt8(offset + 2)),
});

const s06aStatus = (content: Buffer, offset: number): Power => ({
  ignition: (content.readUInt8(offset) & 0x02) !== 0,
  externalVoltage: content.readUInt16BE(offset + 1) / 100,
  batteryLevel: null,
  gsmSignal: gsmPercent(content.readUInt8(offset + 3)),
});

const checked = (
  ctx: DecodeContext,
  fields: Record<string, unknown>,
  alarmCode: number | null,
): Decoded => {
  if (ctx.imei === null) {
    return {
      kind: 'rejected',
      reason: 'no_login',
      detail: 'packet before login',
    };
  }

  const result = DeviceRecord.safeParse({
    v: 1,
    imei: ctx.imei,
    receivedAt: ctx.receivedAt.toISOString(),
    ...fields,
  });

  if (!result.success) {
    return {
      kind: 'rejected',
      reason: 'invalid_record',
      detail: result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  return {
    kind: 'record',
    record: result.data,
    alarm: alarmCode,
  };
};

const accByte = (value: number): boolean | null => {
  if (value === 0x00) {
    return false;
  }

  if (value === 0x01) {
    return true;
  }

  return null;
};

const ignored = (
  reason: 'unknown_type' | 'not_used',
  alarmCode: number | null,
): Decoded => ({
  kind: 'ignored',
  reason,
  alarm: alarmCode,
});

const wrongLength = (protocol: number, content: Buffer): Decoded => ({
  kind: 'rejected',
  reason: 'wrong_length',
  detail: `0x${protocol.toString(16)} with ${String(content.length)} content bytes`,
});
