# Using the API

The web UI is a client of the REST API under `/api/v1`. Nothing is
UI-only: if you can click it, you can call it.

- Interactive reference: `https://<your instance>/api/docs`
- OpenAPI 3.1 document: `https://<your instance>/api/v1/openapi.json`

## Authenticate

Create a token under **API tokens** in the UI. It is shown once. Send it on
every request:

```bash
export BMM=https://bmm.example.com
export BMM_TOKEN=bmm_...

curl -H "Authorization: Bearer $BMM_TOKEN" $BMM/api/v1/auth/me
```

```json
{ "user": { "username": "nik", "...": "..." }, "via": "token", "scopes": ["posts:read", "audit:read"] }
```

A program or agent should call `/auth/me` first: it says which scopes the
token holds, so the caller knows what it may do before trying.

## Scopes

A token carries a list of scopes. `admin` implies all of them.

| Scope                              | Allows                                              |
| ---------------------------------- | --------------------------------------------------- |
| `profiles:read` / `profiles:write` | Reading / changing profiles                         |
| `accounts:read` / `accounts:write` | Listing / connecting social accounts                |
| `posts:read` / `posts:write`       | Reading / creating, scheduling and publishing posts |
| `media:read` / `media:write`       | Reading / uploading media                           |
| `analytics:read`                   | Reading analytics                                   |
| `inbox:read` / `inbox:write`       | Reading / replying to comments and messages         |
| `audit:read`                       | Reading the audit log                               |
| `tokens:read` / `tokens:write`     | Listing / creating and revoking tokens              |

Analytics and the inbox arrive with later milestones; their scopes exist now
so a token created today keeps its meaning.

Two rules keep tokens contained:

- A token can create another token only with scopes it holds itself, and only
  for the profiles it is itself limited to.
- Changing the password and linking single sign-on need a signed-in person.
  No token can do them, not even an `admin` one.

## The resources

| Path                                   | What it is                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `/profiles`                            | Personas. Each owns accounts, media and posts.                                |
| `/networks`                            | Which networks have a developer app configured, and their redirect URIs.      |
| `/accounts`                            | Accounts connected to a profile. Connecting one takes a person in the web UI. |
| `/media`                               | Images. Upload as multipart, or `POST /media/import` with a URL or base64.    |
| `/posts`                               | Drafts, scheduled and published posts, with the outcome per account.          |
| `/posts/validate`                      | Checks a post against each network's rules without saving it.                 |
| `/tokens`, `/audit`, `/system/version` | API tokens, the audit log, the running version.                               |

## Publishing a post

```bash
# 1. Which accounts can this profile post to?
curl -H "Authorization: Bearer $BMM_TOKEN" "$BMM/api/v1/accounts?profileId=$PROFILE"

# 2. Add an image
curl -X POST $BMM/api/v1/media -H "Authorization: Bearer $BMM_TOKEN" \
  -F profileId=$PROFILE -F alt="Our new poster" -F file=@poster.jpg

# 3. Check it first: errors would be refused by the network, warnings are worth knowing
curl -X POST $BMM/api/v1/posts/validate -H "Authorization: Bearer $BMM_TOKEN" -H "Content-Type: application/json" \
  -d '{"profileId":"'$PROFILE'","text":"We are live.","mediaIds":["'$MEDIA'"],"targets":[{"accountId":"'$X_ACCOUNT'"},{"accountId":"'$IG_ACCOUNT'"}]}'

# 4. Schedule it. action is draft, schedule or publish.
curl -X POST $BMM/api/v1/posts -H "Authorization: Bearer $BMM_TOKEN" -H "Content-Type: application/json" \
  -d '{"profileId":"'$PROFILE'","text":"We are live.","mediaIds":["'$MEDIA'"],
       "targets":[{"accountId":"'$X_ACCOUNT'","text":"Live now."},{"accountId":"'$IG_ACCOUNT'"}],
       "action":"schedule","scheduledAt":"2026-12-01T09:30:00+01:00"}'

# 5. Afterwards: a link per account, or the network's error
curl -H "Authorization: Bearer $BMM_TOKEN" $BMM/api/v1/posts/$POST
```

A post's `status` summarises its targets: `draft`, `scheduled`, `publishing`,
`published`, `partial` (some accounts failed) or `failed`. A target that the
network asked to try later is retried up to four times over about twenty
minutes. A target is never resent when BMM cannot know whether it went out;
its error then says so, and `POST /posts/{id}/retry` is yours to call after
checking the account.

For AI agents there is an MCP server with the same abilities: [MCP](mcp.md).

## Errors

Every error has the same shape:

```json
{ "error": { "code": "forbidden", "message": "This API token lacks the \"tokens:read\" scope" } }
```

| Status | `code`                             | Meaning                                                              |
| ------ | ---------------------------------- | -------------------------------------------------------------------- |
| 400    | `validation_failed`, `bad_request` | The request is malformed; the message names the field.               |
| 401    | `unauthorized`                     | No token, or an unknown, revoked or expired one.                     |
| 403    | `forbidden`                        | Authenticated, but not allowed. The message names the missing scope. |
| 404    | `not_found`                        | No such thing.                                                       |
| 409    | `conflict`                         | The request conflicts with the current state.                        |
| 429    | `rate_limited`                     | Too many attempts; wait and retry.                                   |

## Examples

Create a read-only token that expires in 30 days:

```bash
curl -X POST $BMM/api/v1/tokens \
  -H "Authorization: Bearer $BMM_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "reporting", "scopes": ["posts:read", "analytics:read"], "expiresInDays": 30}'
```

Read the audit log, newest first, then the next page:

```bash
curl -H "Authorization: Bearer $BMM_TOKEN" "$BMM/api/v1/audit?limit=50"
curl -H "Authorization: Bearer $BMM_TOKEN" "$BMM/api/v1/audit?limit=50&before=<nextBefore from the last response>"
```
