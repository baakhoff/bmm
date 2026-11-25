# Using BMM from an AI agent (MCP)

BMM has a built-in [Model Context Protocol](https://modelcontextprotocol.io)
server. An assistant that speaks MCP, such as Claude, can list your
profiles, add images, check a post against each network's rules, schedule or
publish it, and report what happened.

- Address: `https://<your BMM address>/mcp`
- Transport: Streamable HTTP
- Sign-in: an API token in the `Authorization` header

## 1. Create a token for the agent

In BMM, **API tokens**, **New token**. Give it what the agent should be able
to do and nothing more. For an agent that writes and schedules posts:

`profiles:read`, `accounts:read`, `media:read`, `media:write`, `posts:read`,
`posts:write`

Through the API you can also limit a token to certain profiles
(`profileIds`), so an agent working for one persona cannot see the others:

```bash
curl -X POST $BMM/api/v1/tokens \
  -H "Authorization: Bearer $BMM_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "studio agent", "scopes": ["profiles:read","accounts:read","media:read","media:write","posts:read","posts:write"], "profileIds": ["<profile id>"], "expiresInDays": 90}'
```

## 2. Connect the agent

Claude Code:

```bash
claude mcp add --transport http bmm https://bmm.example.com/mcp \
  --header "Authorization: Bearer bmm_..."
```

Any client that takes a JSON configuration:

```json
{
  "mcpServers": {
    "bmm": {
      "type": "http",
      "url": "https://bmm.example.com/mcp",
      "headers": { "Authorization": "Bearer bmm_..." }
    }
  }
}
```

The agent has to be able to reach BMM's address. An assistant running on
your own machine can reach an instance inside your network; a hosted one
cannot, unless you expose BMM to it.

## What the agent can do

| Tool                                                                                 | Does                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `whoami`                                                                             | The token's scopes and the profiles it may use.                              |
| `list_profiles`, `get_profile`, `create_profile`, `update_profile`, `delete_profile` | Personas.                                                                    |
| `list_networks`                                                                      | Which networks are set up, and whether Instagram can publish.                |
| `list_accounts`, `disconnect_account`                                                | Connected accounts.                                                          |
| `import_media`, `list_media`, `get_media`, `delete_media`                            | Images, from a public URL or as base64.                                      |
| `validate_post`                                                                      | Checks text, images and targets against each network's rules. Saves nothing. |
| `create_post`, `update_post`                                                         | Drafts, schedules or publishes.                                              |
| `get_post`, `list_posts`                                                             | The outcome per account: a link, or the network's error.                     |
| `retry_post`, `delete_post`                                                          | Try failed accounts again; remove a post from BMM.                           |
| `list_audit_log`                                                                     | What happened on the instance.                                               |

Each tool's description tells the agent when to use it and what to do
first, and the server sends instructions describing the order that works:
`whoami`, `list_profiles`, `list_accounts`, `import_media`, `validate_post`,
`create_post`, `get_post`.

## What the agent cannot do

- **Connect accounts.** That takes a person signing in at the network, in
  the BMM web UI.
- **Go beyond its token.** Scopes and profile limits are enforced on every
  call, the same way as for the REST API.
- **Change sign-in settings or the networks' developer apps**, unless you
  gave it the `admin` scope. Do not.

## Publishing is real

BMM does not put a confirmation step between an agent and a published post.
A token with `posts:write` can publish. The safeguards are:

- **The token.** Give an agent you do not fully trust a token for one
  profile, or leave `posts:write` out and let it only read and validate.
- **The instructions.** The server tells agents to save a draft when the
  person has not clearly asked for a post to go out.
- **The audit log.** Every action is recorded with the token's name, so you
  can always see what an agent did, and revoke its token in one click.

## Trying it without an agent

```bash
curl -s $BMM/mcp \
  -H "Authorization: Bearer $BMM_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```
