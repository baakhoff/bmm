# BMM — Better Marketing Management

A social media manager you host yourself. Free, open source, and built so that
everything a person can click, a script or an AI agent can call.

> **Status: foundation release (0.1).** Sign-in, API tokens, the audit log and
> the deployment tooling work today. Connecting accounts and scheduling posts
> is the next milestone. See the [roadmap](docs/roadmap.md).

## What it is for

- **One place for every network.** X and Instagram first, through their
  official APIs with your own developer credentials. More networks follow.
- **Profiles.** A profile is a persona: its accounts, media, calendar, and
  optionally its own VPN exit, so two personas never share an IP address.
- **API first.** The web UI is a client of the same REST API you get. An
  OpenAPI document and interactive reference ship with every instance.
- **Made for agents.** Scoped API tokens today; an MCP server next, so an AI
  assistant can draft, schedule and report under limits you set.
- **Yours.** Runs on your Kubernetes cluster or with Docker Compose. No
  account with us, no telemetry, no paid tier.

## Try it

One container, embedded database, nothing to configure:

```bash
docker run --rm -p 3000:3000 -v bmm-data:/data ghcr.io/baakhoff/bmm:edge
```

Open <http://localhost:3000> and create the admin account. The embedded
database is for trying things out; for an instance you intend to keep, use one
of the installs below, which run Postgres.

## Install

| Where            | How                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------- |
| Kubernetes       | [Helm chart](docs/install.md#kubernetes-with-helm), also usable from Flux and Argo CD |
| A single machine | [Docker Compose](docs/install.md#docker-compose)                                      |

Then: [configuration](docs/configuration.md) · [single sign-on](docs/configuration.md#single-sign-on) ·
[using the API](docs/api.md)

## What works today

- First-run setup, password sign-in, and sign-in through any OpenID Connect
  provider (Pocket ID, Authentik, Keycloak, Google, ...).
- API tokens with scopes, optional expiry and per-profile limits. A token can
  never mint a token stronger than itself.
- An audit log of every sign-in and change, saying whether a person or a
  token did it.
- OpenAPI 3.1 document at `/api/v1/openapi.json`, reference at `/api/docs`.
- Images for amd64 and arm64. Helm chart with a bundled Postgres, a
  NetworkPolicy, and a non-root, read-only container.

## Development

```bash
pnpm install
pnpm dev        # API on :3000, web UI on :5173
pnpm test
```

More in [docs/development.md](docs/development.md).

## Security

Found a vulnerability? Please report it privately through GitHub's
"Report a vulnerability" button on this repository, not in a public issue.

## License

[AGPL-3.0-only](LICENSE). If you run a modified BMM as a service for others,
you must offer them your source.
