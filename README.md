# gotirekha-parser

Talks to GPS trackers: splits the TCP stream into frames, decodes them, answers the device, and publishes each record for the worker.

## Structure

Folders follow what the code talks to, and imports point one way: `server` uses `protocols`, `database`, `queue` and `disk`; only `main.ts` imports everything.

- `src/main.ts`: starts everything in order; `src/config.ts`: the settings, checked at startup.
- `src/protocols/`: one folder per wire format (`gt06/`). Bytes in, results out: no network, database or queue, so it runs and is tested on its own.
- `src/database/`: the only code that uses Postgres (the registered devices and ports).
- `src/queue/`: the only code that uses NATS (the stream, publishing, the publish window).
- `src/server/`: the only code that uses TCP (ports, connections, limits, stats).
- `src/disk/`: the only code that writes files (the frame log).
- `src/tools/`: offline tools such as `replay.ts`; the server never imports them.

Imports name the real file; there are no `index.ts` files that only re-export.

## Scripts

- `pnpm build`: compile `src/` to `dist/`.
- `pnpm typecheck`: check types without writing files.
- `pnpm lint`: run ESLint.
- `pnpm test`: run the tests with Node's own runner (Node runs the `.ts` files directly).
- `pnpm replay <file>`: replay a capture or a frame log through the framer and decoder and print a report; `--frames` prints one decoded line per frame instead.
- `pnpm send <file>`: play a capture or a frame log to a parser port (`--port`, default 7878) like a device, at the recorded pace (`--speed N` for N times faster, `--burst` for all at once); it logs in first, with `--imei` or the file's first login, and every login in the file is sent with that IMEI; `--now` moves the location dates so the latest is now, keeping the gaps.
- `pnpm start`: run the parser with the settings in `.env` (copy `.env.example`).

## Frame log

Every byte a logged-in device sends and every reply, kept `FRAME_LOG_DAYS` days in `FRAME_LOG_DIR`: one gzip file per UTC day, `frames-YYYY-MM-DD.jsonl.gz`, one JSON line per TCP read (`dir: "in"`), reply (`"out"`), login or close (`event`, with `reason`). Read it with `zcat` (Git Bash). A restart appends to the day's file; older files are deleted by the parser at startup and every hour. If the disk falls behind, lines are dropped and counted in `frameLogDropped`; devices are never slowed by it.

## Schemas

`@gotirekha/schemas` is installed from GitHub by tag, and pnpm only lets it run its build script when the exact commit is listed in `pnpm-workspace.yaml` (`allowBuilds`). Raising the version takes both:

1. `pnpm add github:ifoysalahmmed/gotirekha-schemas#vX.Y.Z`
2. Replace the commit hash in `pnpm-workspace.yaml`; the install error prints the new one.
