# Roadmap

BMM is built in vertical slices: each milestone ends with something that
works end to end, in the UI, through the API and, from milestone 2, through
MCP.

| #   | Milestone                                                                                                                                                                                                                                                                                                                                            | State   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Foundation.** Sign-in (password and OIDC), scoped API tokens, audit log, OpenAPI, images, Helm chart, Compose.                                                                                                                                                                                                                                     | Done    |
| 2   | **First post.** Profiles, connecting X and Instagram accounts through their official APIs, image upload, scheduling and publishing a post; the same flow through the API and an MCP server. Guides for creating the X and Meta developer apps. A public edge (own ingress, Cloudflare Tunnel or a small relay) for the media URLs Instagram fetches. | Done    |
| 3   | **Egress.** A VPN per profile with a kill switch on by default, plus SOCKS5 and HTTP proxies.                                                                                                                                                                                                                                                        | Next    |
| 4   | **Composer and calendar.** Calendar view, video, cropping and resizing for each network, threads.                                                                                                                                                                                                                                                    | Planned |
| 5   | **Analytics and inbox.** Instagram first.                                                                                                                                                                                                                                                                                                            | Planned |
| 6   | **AI assist.** Bring your own model key (OpenAI-compatible, Anthropic, others). The built-in assistant works only through BMM's own tools and treats fetched content as data.                                                                                                                                                                        | Planned |
| 7   | **Browser layer.** Automation for what the official APIs cannot do, with a hand-off to a person when a network asks for one.                                                                                                                                                                                                                         | Planned |
| —   | **Later.** More networks, several users with roles.                                                                                                                                                                                                                                                                                                  | Planned |

## Design decisions

- **Official APIs first.** They cannot get an account banned. Browser
  automation is an optional layer on top, for the gaps.
- **Single admin for now.** Every table still records its owner, so several
  users later is an addition, not a rewrite.
- **Agents are trusted with what their token allows.** The limits are scopes
  and profiles on the token, and the audit log records everything.
- **No Redis, no object store.** The schedule is rows in Postgres, claimed
  one at a time, and media is a directory on a volume. Fewer things to run
  and back up; both sit behind interfaces that a queue or S3 can replace.
- **Never post twice.** When BMM cannot know whether a network accepted a
  post, it stops and says so instead of sending it again.
