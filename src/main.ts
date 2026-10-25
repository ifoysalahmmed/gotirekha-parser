import pg from 'pg';
import pino from 'pino';
import { loadConfig } from './config.ts';
import { readPorts, Registry } from './database/registry.ts';
import { connectQueue, createPublish, ensureStream } from './queue/queue.ts';
import { ParserServer } from './server/server.ts';
import { takeStats } from './server/stats.ts';

const config = loadConfig();

const logger = pino({
  name: 'parser',
  level: config.LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
});

const pool = new pg.Pool({
  host: config.PGHOST,
  port: config.PGPORT,
  database: config.PGDATABASE,
  user: config.PGUSER,
  password: config.PGPASSWORD,
  max: 1,
});

pool.on('error', (err) => {
  logger.warn(
    {
      err,
    },
    'database connection lost',
  );
});

const ports = await readPorts(pool);

if (ports.length === 0) {
  throw new Error('parser_ports is empty, so there is no port to listen on');
}

const registry = new Registry(pool, logger);

await registry.load();

logger.info(
  {
    devices: registry.size,
  },
  'registry loaded',
);

const nc = await connectQueue(config.NATS_URL);

await ensureStream(nc, config.STREAM_MAX_BYTES);

logger.info(
  {
    url: config.NATS_URL,
  },
  'queue ready',
);

void (async () => {
  for await (const status of nc.status()) {
    if (status.type === 'disconnect') {
      logger.warn('queue disconnected');
    } else if (status.type === 'reconnect') {
      logger.info('queue reconnected');
    } else {
      logger.debug(
        {
          type: status.type,
        },
        'queue status',
      );
    }
  }
})();

const server = new ParserServer({
  host: config.PARSER_HOST,
  registry,
  publish: createPublish(nc, config.PUBLISH_TIMEOUT_MS),
  logger,
  maxPendingPublishes: config.MAX_PENDING_PUBLISHES,
});

registry.start(config.REGISTRY_RELOAD_S * 1000, (imeis) => {
  server.applyChanges(imeis);
});

for (const { port, protocol } of ports) {
  if (protocol !== 'gt06') {
    throw new Error(
      `no decoder for protocol ${protocol} on port ${String(port)}`,
    );
  }

  await server.listen(port);

  logger.info(
    {
      host: config.PARSER_HOST,
      port,
      protocol,
    },
    'listening',
  );
}

const statsTimer = setInterval(() => {
  logger.info(
    {
      connections: server.connectionCount,
      online: server.onlineDevices,
      pending: server.pendingPublishes,
      registered: registry.size,
      ...takeStats(server.stats),
    },
    'stats',
  );
}, config.STATS_INTERVAL_S * 1000);

statsTimer.unref();

let stopping = false;

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }

  stopping = true;
  logger.info(
    {
      signal,
    },
    'shutting down',
  );

  clearInterval(statsTimer);
  registry.stop();
  await server.stop(config.SHUTDOWN_GRACE_MS);
  await nc.drain();
  await pool.end();

  logger.info('stopped');
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown(signal).then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error(
          {
            err,
          },
          'shutdown failed',
        );
        process.exit(1);
      },
    );
  });
}
