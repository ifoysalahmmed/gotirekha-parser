import { z } from 'zod';

const positive = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const text = (fallback: string) => z.string().min(1).default(fallback);

const Config = z.object({
  PARSER_HOST: text('0.0.0.0'),
  NATS_URL: text('nats://127.0.0.1:4222'),
  STREAM_MAX_BYTES: positive(1024 ** 3),
  PGHOST: text('localhost'),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGDATABASE: text('gotirekha'),
  PGUSER: text('gotirekha_parser'),
  PGPASSWORD: z.string().min(1),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  MAX_PENDING_PUBLISHES: z.coerce.number().int().min(2).default(5000),
  PUBLISH_TIMEOUT_MS: positive(5000),
  REGISTRY_RELOAD_S: positive(60),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(5000),
  STATS_INTERVAL_S: positive(60),
});

export type Config = z.infer<typeof Config>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = Config.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );

    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }

  return result.data;
};
