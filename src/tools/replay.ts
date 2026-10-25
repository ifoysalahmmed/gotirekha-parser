import { IMEI, Variant, type PositionRecord } from '@gotirekha/schemas';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { decode, type Decoded } from '../protocols/gt06/decode.ts';
import { Gt06Framer } from '../protocols/gt06/framer.ts';
import { replyFor } from '../protocols/gt06/reply.ts';

interface Connection {
  framer: Gt06Framer;
  imei: string | null;
}

interface Tally {
  counts: Map<string, number>;
  examples: Map<string, string>;
}

const BANGLADESH = {
  minLat: 20.5,
  maxLat: 26.7,
  minLon: 88.0,
  maxLon: 92.7,
};

const tally = (): Tally => ({
  counts: new Map(),
  examples: new Map(),
});

const count = (into: Tally, key: string, example?: string): void => {
  into.counts.set(key, (into.counts.get(key) ?? 0) + 1);

  if (example !== undefined && !into.examples.has(key)) {
    into.examples.set(key, example);
  }
};

const protocolName = (protocol: number): string =>
  `0x${protocol.toString(16).padStart(2, '0')}`;

const outcomeName = (decoded: Decoded): string => {
  switch (decoded.kind) {
    case 'login':
      return 'login';
    case 'record':
      return decoded.record.kind;
    case 'ignored':
      return `ignored ${decoded.reason}`;
    case 'rejected':
      return `rejected ${decoded.reason}`;
  }
};

const sanityProblems = (record: PositionRecord): string[] => {
  const problems: string[] = [];

  if (record.deviceTime === null) {
    problems.push('device time missing');
  } else {
    const behindMinutes =
      (Date.parse(record.receivedAt) - Date.parse(record.deviceTime)) / 60_000;
    const wholeHours = Math.round(behindMinutes / 60);

    if (
      wholeHours !== 0 &&
      Math.abs(wholeHours) <= 14 &&
      Math.abs(behindMinutes - wholeHours * 60) < 2
    ) {
      problems.push(
        `device time exactly ${String(Math.abs(wholeHours))} h ${wholeHours < 0 ? 'ahead' : 'behind'}`,
      );
    } else if (behindMinutes < -5) {
      problems.push('device time more than 5 min ahead');
    } else if (behindMinutes > 24 * 60) {
      problems.push('device time more than 1 day behind');
    } else if (behindMinutes > 10) {
      problems.push('device time more than 10 min behind');
    }
  }

  if (!record.gpsFixed) {
    problems.push('not fixed');
  } else if (
    record.lat < BANGLADESH.minLat ||
    record.lat > BANGLADESH.maxLat ||
    record.lon < BANGLADESH.minLon ||
    record.lon > BANGLADESH.maxLon
  ) {
    problems.push('outside Bangladesh while fixed');
  }

  if (record.speedKmh > 160) {
    problems.push('speed above 160 km/h');
  }

  return problems;
};

const payloadMismatches = (
  record: PositionRecord,
  expected: Record<string, unknown>,
): string[] => {
  const mismatches: string[] = [];
  const { latitude, longitude, speed, bearing } = expected;

  if (typeof latitude === 'number' && typeof longitude === 'number') {
    if (
      Math.abs(record.lat - latitude) > 1e-6 ||
      Math.abs(record.lon - longitude) > 1e-6
    ) {
      mismatches.push(
        `lat/lon ours ${String(record.lat)},${String(record.lon)} logged ${String(latitude)},${String(longitude)}`,
      );
    }
  }

  if (typeof speed === 'number' && Math.abs(record.speedKmh - speed) > 0.5) {
    mismatches.push(
      `speed ours ${String(record.speedKmh)} logged ${String(speed)}`,
    );
  }

  if (typeof bearing === 'number' && record.course !== bearing) {
    mismatches.push(
      `course ours ${String(record.course)} logged ${String(bearing)}`,
    );
  }

  return mismatches;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const printTally = (title: string, from: Tally): void => {
  console.log(`\n${title}`);

  if (from.counts.size === 0) {
    console.log('  none');

    return;
  }

  for (const [key, value] of [...from.counts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const example = from.examples.get(key);

    console.log(`  ${key}: ${String(value)}`);

    if (example !== undefined) {
      console.log(`    e.g. ${example}`);
    }
  }
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      variant: { type: 'string' },
      imei: { type: 'string' },
    },
  });
  const [file] = positionals;

  if (file === undefined) {
    console.error(
      'usage: pnpm replay <file.jsonl | file.gz> [--variant et27|s06a|s102a] [--imei <imei>]',
    );
    process.exitCode = 1;

    return;
  }

  const variant =
    values.variant === undefined ? null : Variant.parse(values.variant);
  const startImei = values.imei === undefined ? null : IMEI.parse(values.imei);
  const connections = new Map<string, Connection>();
  const lines = { read: 0, skipped: 0, frames: 0 };
  const discards = tally();
  const outcomes = tally();
  const sanity = tally();
  const mismatches = tally();
  const alarms = tally();
  const replies = tally();
  let compared = 0;

  const input = createReadStream(file);
  const stream = file.endsWith('.gz') ? input.pipe(createGunzip()) : input;

  for await (const text of createInterface({
    input: stream,
    crlfDelay: Infinity,
  })) {
    if (text.trim() === '') {
      continue;
    }

    lines.read += 1;

    const line = asObject(JSON.parse(text));
    const hex = line?.hex;
    const time = line?.received ?? line?.time;

    if (
      line === null ||
      typeof hex !== 'string' ||
      typeof time !== 'string' ||
      (line.dir !== undefined && line.dir !== 'in')
    ) {
      lines.skipped += 1;
      continue;
    }

    const peer = typeof line.peer === 'string' ? line.peer : file;
    let connection = connections.get(peer);

    if (connection === undefined) {
      connection = {
        framer: new Gt06Framer(),
        imei: startImei,
      };
      connections.set(peer, connection);
    }

    const receivedAt = new Date(time);
    const outputs = connection.framer.push(Buffer.from(hex, 'hex'));
    const frameCount = outputs.filter(
      (output) => output.type === 'frame',
    ).length;

    for (const output of outputs) {
      if (output.type === 'discard') {
        count(
          discards,
          output.reason,
          (output.candidate ?? output.bytes).toString('hex'),
        );
        continue;
      }

      const { frame } = output;
      const decoded = decode(frame, {
        imei: connection.imei,
        variant,
        receivedAt,
      });
      const protocol = protocolName(frame.protocol);
      const reply = replyFor(frame, receivedAt);

      lines.frames += 1;
      count(
        outcomes,
        `${protocol} ${outcomeName(decoded)}`,
        decoded.kind === 'rejected'
          ? `${frame.raw.toString('hex')} (${decoded.detail})`
          : undefined,
      );

      if (reply !== null) {
        count(replies, protocol);
      }

      if (decoded.kind === 'login') {
        connection.imei = decoded.imei;
      }

      if (decoded.kind === 'record' || decoded.kind === 'ignored') {
        if (decoded.alarm !== null) {
          count(alarms, `${protocol} alarm ${protocolName(decoded.alarm)}`);
        }
      }

      if (decoded.kind !== 'record' || decoded.record.kind !== 'position') {
        continue;
      }

      const { record } = decoded;

      for (const problem of sanityProblems(record)) {
        count(sanity, problem, frame.raw.toString('hex'));
      }

      const expected = asObject(line.payload);

      if (frameCount === 1 && expected !== null) {
        compared += 1;

        for (const mismatch of payloadMismatches(record, expected)) {
          count(
            mismatches,
            mismatch.split(' ')[0] ?? mismatch,
            `${mismatch} (${frame.raw.toString('hex')})`,
          );
        }
      }
    }
  }

  console.log(`file: ${file}`);
  console.log(`variant: ${variant ?? 'gt06'}`);
  console.log(
    `lines: ${String(lines.read)} read, ${String(lines.skipped)} skipped; frames: ${String(lines.frames)}; connections: ${String(connections.size)}`,
  );
  printTally('Discards', discards);
  printTally('Per protocol', outcomes);
  printTally('Sanity checks on positions', sanity);
  printTally(
    `Against the logged payload (${String(compared)} single-packet positions compared)`,
    mismatches,
  );
  printTally('Alarm codes', alarms);
  printTally('Replies we would send', replies);
};

await main();
