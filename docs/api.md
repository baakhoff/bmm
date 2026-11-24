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

The resources behind several of these arrive with later milestones. The
scopes exist now so a token created today keeps its meaning.

Two rules keep tokens contained:

- A token can create another token only with scopes it holds itself, and only
  for the profiles it is itself limited to.
- Changing the password and linking single sign-on need a signed-in person.
  No token can do them, not even an `admin` one.

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
