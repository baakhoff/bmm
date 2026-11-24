# Configuration

BMM is configured through environment variables. The Helm chart and the
Compose file set them from their own values; the names are the same idea in
each.

| Variable                | Default                          | Meaning                                                                                                                                                                                         |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `pglite:///data/pg` in the image | `postgres://user:pass@host:5432/db` for Postgres. `pglite://<directory>` runs an embedded Postgres inside the BMM process: no server to manage, single process only, meant for trying BMM out.  |
| `BMM_PUBLIC_URL`        | unset                            | The address people open BMM at, such as `https://bmm.example.com`. Required for single sign-on. Also decides whether the session cookie is marked Secure.                                       |
| `BMM_TRUST_PROXY`       | `false`                          | Set to `true` behind an ingress or reverse proxy, so client addresses in the audit log are the real ones. Leave off if BMM is exposed directly, or clients could forge their address.           |
| `BMM_SETUP_TOKEN`       | unset                            | If set, creating the first admin requires this value.                                                                                                                                           |
| `BMM_PASSWORD_LOGIN`    | `true`                           | `false` turns password sign-in off entirely. Only allowed when single sign-on is configured.                                                                                                    |
| `BMM_SESSION_TTL_DAYS`  | `30`                             | How long a browser session lasts.                                                                                                                                                               |
| `BMM_UPDATE_CHECK`      | `true`                           | Ask GitHub's public API a few times a day whether a newer release exists, and show a notice if so. Nothing about the instance is sent. `false` makes BMM contact nothing you did not configure. |
| `BMM_HOST` / `BMM_PORT` | `0.0.0.0` / `3000`               | Listen address.                                                                                                                                                                                 |
| `BMM_LOG_LEVEL`         | `info`                           | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                 |

## Single sign-on

BMM signs in through any OpenID Connect provider: Pocket ID, Authentik,
Keycloak, Authelia, Zitadel, Google and so on.

| Variable                   | Meaning                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `BMM_OIDC_ISSUER`          | The provider's issuer URL, e.g. `https://id.example.com`.         |
| `BMM_OIDC_CLIENT_ID`       | The client ID the provider gave you.                              |
| `BMM_OIDC_CLIENT_SECRET`   | The client secret. Omit for a public client; PKCE is always used. |
| `BMM_OIDC_NAME`            | The label on the button, e.g. `Pocket ID`. Default `SSO`.         |
| `BMM_OIDC_SCOPES`          | Default `openid profile email`.                                   |
| `BMM_OIDC_ALLOWED_EMAIL`   | See "Who gets in" below.                                          |
| `BMM_OIDC_ALLOWED_SUBJECT` | See "Who gets in" below.                                          |

At the provider, register this redirect URI:

```
<BMM_PUBLIC_URL>/api/v1/auth/oidc/callback
```

### Who gets in

Being able to sign in at your identity provider does not make someone the
BMM admin. The rules:

1. **Fresh instance.** The first person to sign in through SSO becomes the
   admin. If a setup token is configured, only the identity named by
   `BMM_OIDC_ALLOWED_EMAIL` or `BMM_OIDC_ALLOWED_SUBJECT` may do this.
2. **Admin already exists and is linked.** Only the linked identity signs in.
3. **Admin exists, created with a password.** Sign in with the password and
   press "Connect" under Settings. Or set `BMM_OIDC_ALLOWED_EMAIL` to your
   email (the provider must report it as verified) or
   `BMM_OIDC_ALLOWED_SUBJECT` to your `sub`, and the first SSO sign-in by
   that identity links itself.

### Pocket ID, step by step

1. In Pocket ID, go to **OIDC Clients** and add a client named BMM.
2. Set the callback URL to `https://<your BMM host>/api/v1/auth/oidc/callback`.
3. Copy the client ID and client secret.
4. Configure BMM with `BMM_OIDC_ISSUER=https://<your Pocket ID host>`,
   the client ID and secret, and `BMM_OIDC_NAME=Pocket ID`.
5. Optionally set `BMM_PASSWORD_LOGIN=false` once SSO works.
