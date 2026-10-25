export interface Stats {
  connectionsOpened: number;
  connectionsClosed: number;
  logins: number;
  loginsRefused: number;
  takeovers: number;
  frames: number;
  rejected: number;
  published: number;
  publishFailed: number;
  replies: number;
  discardedBytes: number;
  crcErrors: number;
  handlerErrors: number;
}

export const createStats = (): Stats => ({
  connectionsOpened: 0,
  connectionsClosed: 0,
  logins: 0,
  loginsRefused: 0,
  takeovers: 0,
  frames: 0,
  rejected: 0,
  published: 0,
  publishFailed: 0,
  replies: 0,
  discardedBytes: 0,
  crcErrors: 0,
  handlerErrors: 0,
});

export const takeStats = (stats: Stats): Stats => {
  const snapshot = {
    ...stats,
  };

  Object.assign(stats, createStats());

  return snapshot;
};
