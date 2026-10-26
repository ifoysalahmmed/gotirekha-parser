export interface Stats {
  connectionsOpened: number;
  connectionsClosed: number;
  preLoginRefused: number;
  loginDeadlines: number;
  junkBeforeLogin: number;
  logins: number;
  loginsRefused: number;
  takeovers: number;
  idleTimeouts: number;
  frames: number;
  rejected: number;
  throttled: number;
  published: number;
  publishFailed: number;
  replies: number;
  discardedBytes: number;
  crcErrors: number;
  handlerErrors: number;
  frameLogDropped: number;
}

export const createStats = (): Stats => ({
  connectionsOpened: 0,
  connectionsClosed: 0,
  preLoginRefused: 0,
  loginDeadlines: 0,
  junkBeforeLogin: 0,
  logins: 0,
  loginsRefused: 0,
  takeovers: 0,
  idleTimeouts: 0,
  frames: 0,
  rejected: 0,
  throttled: 0,
  published: 0,
  publishFailed: 0,
  replies: 0,
  discardedBytes: 0,
  crcErrors: 0,
  handlerErrors: 0,
  frameLogDropped: 0,
});

export const takeStats = (stats: Stats): Stats => {
  const snapshot = {
    ...stats,
  };

  Object.assign(stats, createStats());

  return snapshot;
};
