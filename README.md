# BMM — Better Marketing Management

[![CI](https://github.com/baakhoff/bmm/actions/workflows/ci.yml/badge.svg)](https://github.com/baakhoff/bmm/actions/workflows/ci.yml)
[![Security](https://github.com/baakhoff/bmm/actions/workflows/security.yml/badge.svg)](https://github.com/baakhoff/bmm/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/baakhoff/bmm)](https://github.com/baakhoff/bmm/releases)

A social media manager you host yourself. Free, open source, and built so that
everything a person can click, a script or an AI agent can call.

> **Status: 0.2.** Profiles, X and Instagram accounts, images, scheduling and
> publishing work, in the web UI, through the REST API and through MCP.
> Video, analytics, the inbox and per-profile VPNs are next. See the
> [roadmap](docs/roadmap.md).

## What it is for

- **One place for every network.** X and Instagram first, through their
  official APIs with your own developer credentials. More networks follow.
- **Profiles.** A profile is a persona: its accounts, media, calendar, and
  optionally its own VPN exit, so two personas never share an IP address.
- **API first.** The web UI is a client of the same REST API you get. An
  OpenAPI document and interactive reference ship with every instance.
- **Made for agents.** A built-in MCP server lets an AI assistant draft,
  check, schedule and report, under the limits of the token you give it.
- **Yours.** Runs on your Kubernetes cluster or with Docker Compose. No
  account with us, no telemetry, no paid tier. The only call home is a
  check for new releases against GitHub's public API, and one setting turns
  it off.

## Try it

One container, embedded database, nothing to configure:

```bash
docker run --rm -p 3000:3000 -v bmm-data:/data ghcr.io/baakhoff/bmm:latest
```

Open <http://localhost:3000> and create the admin account. The embedded
database is for trying things out; for an instance you intend to keep, use one
of the installs below, which run Postgres.

## Install

| Where            | How                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------- |
| Kubernetes       | [Helm chart](docs/install.md#kubernetes-with-helm), also usable from Flux and Argo CD |
| A single machine | [Docker Compose](docs/install.md#docker-compose)                                      |

Then: [connect X](docs/networks/x.md) · [connect Instagram](docs/networks/instagram.md) · [public media](docs/public-media.md) · [MCP](docs/mcp.md) · [configuration](docs/configuration.md) · [single sign-on](docs/configuration.md#single-sign-on) ·
[using the API](docs/api.md) · [updating](docs/updating.md)

## What works today

- **Profiles** that keep each persona's accounts, images and posts apart.
- **X and Instagram** through their official APIs, with your own developer
  apps. Step-by-step guides: [X](docs/networks/x.md),
  [Instagram](docs/networks/instagram.md).
- **One post, several accounts**, with different text per account, images
  with alt text, and Instagram carousels.
- **Checked before it is sent.** Each network's rules are applied as you
  type; a post that would be refused cannot be scheduled.
- **Scheduling that fails honestly.** Retries when a network says "not
  now", never sends twice when it cannot know whether a post went out, and
  shows the network's own error when it does not.
- **REST API** with an OpenAPI document and interactive reference, and
  **API tokens** limited by scope and by profile.
- **[MCP server](docs/mcp.md)** so an AI agent can draft, check, schedule
  and report, within the token you give it.
- **Audit log** of every change and every publish attempt, by person, token
  or scheduler.
- Sign-in with a password or any OpenID Connect provider. Credentials for
  the networks are encrypted in the database.
- Images for amd64 and arm64, a Helm chart, Docker Compose, and a notice
  when a newer release exists.

## Development

```bash
pnpm install
pnpm dev        # API on :3000, web UI on :5173
pnpm test
```

More in [docs/development.md](docs/development.md).

## Security

Dependencies, code and every published image are scanned on each change and
again every night; images carry an SBOM and signed build provenance. To
report a vulnerability privately, and for how to verify an image, see
[SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE). If you run a modified BMM as a service for others,
you must offer them your source.
