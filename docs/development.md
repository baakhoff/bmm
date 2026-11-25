# Development

You need Node 22 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the API on <http://localhost:3000> with an embedded
database under `apps/server/data/`, and the web UI on
<http://localhost:5173>, which proxies `/api` to the API. Open the second
address.

## Trying the whole thing without real accounts

```bash
pnpm build
cd apps/server && pnpm tsx test/e2e-server.ts
```

starts a complete instance at <http://127.0.0.1:3920> whose X and Instagram
are stand-ins: connecting an account approves instantly and publishing
records the calls instead of posting. Enter `x-client` / `x-secret` and
`ig-client` / `ig-secret` under Networks.

## Layout

```
apps/server       Fastify API, MCP server, scheduler, network connectors,
                  database schema and migrations
apps/web          React web UI
packages/shared   Zod schemas shared by both: the single source for request
                  and response shapes, the OpenAPI document and the UI's types
deploy/helm/bmm   Helm chart
deploy/compose    Docker Compose install
```

## Commands

| Command                                 | Does                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| `pnpm test`                             | Runs the server's tests against an in-memory database.              |
| `pnpm typecheck`                        | Type-checks every package.                                          |
| `pnpm lint` / `pnpm format`             | Checks / fixes formatting and lint with Biome.                      |
| `pnpm build`                            | Builds everything.                                                  |
| `pnpm --filter @bmm/server db:generate` | Writes a migration after you change `apps/server/src/db/schema.ts`. |
| `pnpm --filter @bmm/server openapi`     | Prints the OpenAPI document.                                        |

## Conventions

- A request or response shape is a Zod schema in `packages/shared`. Routes
  validate with it and the UI imports its type; do not write the shape twice.
- Logic lives in `apps/server/src/services`, taking an actor. REST routes and
  MCP tools are thin wrappers around the same functions, so they cannot drift.
- A network is a connector in `apps/server/src/connectors` implementing one
  interface. Its errors say what happens next: retry, give up, reconnect, or
  "unknown, do not resend".
- Every state change calls `audit()` or `auditAs()`.
- Every route declares the scope it needs with `requireAuth('<scope>')`.
- Tests go through HTTP (`app.inject`) and assert behaviour a user would
  notice, not internals.

## Testing single sign-on locally

`apps/server/test/oidc.test.ts` runs a small identity provider in-process and
walks the whole redirect flow. To try against a real provider, set the
`BMM_OIDC_*` variables and `BMM_PUBLIC_URL=http://localhost:5173`, and
register `http://localhost:5173/api/v1/auth/oidc/callback` there.

## Releasing

1. Make sure `main` is green.
2. Set the new version in the four `package.json` files and in
   `deploy/helm/bmm/Chart.yaml` (`version` and `appVersion`), and commit.
3. Tag the pushed commit, not whatever a local clone happens to hold:
   `git fetch origin && git tag -a v1.2.3 -m "BMM 1.2.3" origin/main && git push origin v1.2.3`.

The Publish workflow refuses a tag whose version differs from the one in the
source it points at, which is what a tag made on a stale clone looks like.

The Publish workflow builds the image for both architectures, walks through
it, scans it, pushes the chart to `oci://ghcr.io/baakhoff/charts/bmm` and
creates the GitHub release. A fixable high or critical CVE in the image
stops the release before it is announced.
