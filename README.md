# gotirekha-parser

Talks to GPS trackers: splits the TCP stream into frames, decodes them, answers the device, and publishes each record for the worker.

## Structure

Folders follow what the code talks to, and imports point one way: `server` uses `protocols`, `database` and `queue`; only `main.ts` imports everything.

- `src/main.ts`: starts everything in order; `src/config.ts`: the settings, checked at startup.
- `src/protocols/`: one folder per wire format (`gt06/`). Bytes in, results out: no network, database or queue, so it runs and is tested on its own.
- `src/database/`: the only code that uses Postgres (the registered devices and ports).
- `src/queue/`: the only code that uses NATS (the stream, publishing, the publish window).
- `src/server/`: the only code that uses TCP (ports, connections, stats).
- `src/tools/`: offline tools such as `replay.ts`; the server never imports them.

Imports name the real file; there are no `index.ts` files that only re-export.

## Scripts

- `pnpm build`: compile `src/` to `dist/`.
- `pnpm typecheck`: check types without writing files.
- `pnpm lint`: run ESLint.
- `pnpm test`: run the tests with Node's own runner (Node runs the `.ts` files directly).
- `pnpm replay <file>`: replay a capture through the framer and decoder and print a report.
- `pnpm start`: run the parser with the settings in `.env` (copy `.env.example`).

## Schemas

`@gotirekha/schemas` is installed from GitHub by tag, and pnpm only lets it run its build script when the exact commit is listed in `pnpm-workspace.yaml` (`allowBuilds`). Raising the version takes both:

1. `pnpm add github:ifoysalahmmed/gotirekha-schemas#vX.Y.Z`
2. Replace the commit hash in `pnpm-workspace.yaml`; the install error prints the new one.
