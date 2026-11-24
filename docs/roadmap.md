# Roadmap

BMM is built in vertical slices: each milestone ends with something that
works end to end, in the UI, through the API and, from milestone 2, through
MCP.

| #   | Milestone                                                                                                                                                                                                                                                                                                                                                   | State   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Foundation.** Sign-in (password and OIDC), scoped API tokens, audit log, OpenAPI, images, Helm chart, Compose.                                                                                                                                                                                                                                            | Done    |
| 2   | **First post.** Profiles, connecting one X and one Instagram account through their official APIs, media upload, scheduling and publishing a post; the same flow through the API and an MCP server. Guides for creating the X and Meta developer apps. A public edge (own ingress, Cloudflare Tunnel or a small relay) for the media URLs Instagram fetches. | Next    |
| 3   | **Egress.** A VPN per profile with a kill switch on by default, plus SOCKS5 and HTTP proxies.                                                                                                                                                                                                                                                               | Planned |
| 4   | **Composer and calendar.** Per-network variants of one post, drafts, calendar view, transcoding presets, several accounts per network.                                                                                                                                                                                                                      | Planned |
| 5   | **Analytics and inbox.** Instagram first.                                                                                                                                                                                                                                                                                                                   | Planned |
| 6   | **AI assist.** Bring your own model key (OpenAI-compatible, Anthropic, others). The built-in assistant works only through BMM's own tools and treats fetched content as data.                                                                                                                                                                               | Planned |
| 7   | **Browser layer.** Automation for what the official APIs cannot do, with a hand-off to a person when a network asks for one.                                                                                                                                                                                                                                | Planned |
| —   | **Later.** More networks, several users with roles.                                                                                                                                                                                                                                                                                                         | Planned |

## Design decisions

- **Official APIs first.** They cannot get an account banned. Browser
  automation is an optional layer on top, for the gaps.
- **Single admin for now.** Every table still records its owner, so several
  users later is an addition, not a rewrite.
- **Agents are trusted with what their token allows.** The limits are scopes
  and profiles on the token, and the audit log records everything.
