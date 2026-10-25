import {
  RECORDS_STREAM,
  RECORDS_SUBJECTS,
  recordSubject,
  type DeviceRecord,
} from '@gotirekha/schemas';
import {
  DiscardPolicy,
  jetstream,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  StoreCompression,
  type JetStreamManager,
  type StreamInfo,
  type StreamUpdateConfig,
} from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';

export type Publish = (
  record: DeviceRecord,
  messageId: string,
) => Promise<void>;

const DUPLICATE_WINDOW_NS = 2 * 60 * 1_000_000_000;

export const connectQueue = (url: string): Promise<NatsConnection> =>
  connect({
    servers: url,
    name: 'gotirekha-parser',
    maxReconnectAttempts: -1,
  });

export const ensureStream = async (
  nc: NatsConnection,
  maxBytes: number,
): Promise<void> => {
  const jsm = await jetstreamManager(nc);
  const settings: Partial<StreamUpdateConfig> = {
    subjects: [RECORDS_SUBJECTS],
    discard: DiscardPolicy.New,
    max_bytes: maxBytes,
    duplicate_window: DUPLICATE_WINDOW_NS,
    compression: StoreCompression.S2,
    num_replicas: 1,
  };
  const info = await findStream(jsm);

  if (info === null) {
    await jsm.streams.add({
      ...settings,
      name: RECORDS_STREAM,
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
    });

    return;
  }

  const { retention, storage } = info.config;

  if (retention !== RetentionPolicy.Workqueue || storage !== StorageType.File) {
    throw new Error(
      `stream ${RECORDS_STREAM} has retention ${retention} and storage ${storage}; it must be workqueue and file`,
    );
  }

  await jsm.streams.update(RECORDS_STREAM, settings);
};

export const createPublish = (
  nc: NatsConnection,
  timeoutMs: number,
): Publish => {
  const js = jetstream(nc);

  return async (record, messageId) => {
    await js.publish(recordSubject(record.imei), JSON.stringify(record), {
      msgID: messageId,
      timeout: timeoutMs,
    });
  };
};

export const messageId = (imei: string, serial: number, crc: number): string =>
  `${imei}:${String(serial)}:${String(crc)}`;

const findStream = async (
  jsm: JetStreamManager,
): Promise<StreamInfo | null> => {
  try {
    return await jsm.streams.info(RECORDS_STREAM);
  } catch (err) {
    if (
      err instanceof JetStreamApiError &&
      err.code === JetStreamApiCodes.StreamNotFound
    ) {
      return null;
    }

    throw err;
  }
};
