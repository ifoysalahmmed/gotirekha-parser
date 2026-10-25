# gotirekha-parser

Talks to GPS trackers: splits the TCP stream into frames, decodes them, answers the device, and publishes each record for the worker.

## Scripts

- `pnpm build`: compile `src/` to `dist/`.
- `pnpm typecheck`: check types without writing files.
- `pnpm lint`: run ESLint.
- `pnpm test`: run the tests with Node's own runner (Node runs the `.ts` files directly).

## Schemas

`@gotirekha/schemas` is installed from GitHub by tag, and pnpm only lets it run its build script when the exact commit is listed in `pnpm-workspace.yaml` (`allowBuilds`). Raising the version takes both:

1. `pnpm add github:ifoysalahmmed/gotirekha-schemas#vX.Y.Z`
2. Replace the commit hash in `pnpm-workspace.yaml`; the install error prints the new one.
