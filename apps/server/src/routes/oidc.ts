import { ErrorSchema } from '@bmm/shared';
import { and, count, eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireSession, startSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { oidcStates, users } from '../db/schema.js';
import { uuidv7 } from '../lib/crypto.js';
import { badRequest, HttpError } from '../lib/errors.js';

const STATE_TTL_MS = 10 * 60_000;

class OidcDenied extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function usernameFrom(claims: Record<string, unknown>): string {
  const raw =
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    (typeof claims.email === 'string' && claims.email.split('@')[0]) ||
    'admin';
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, '-')
    .slice(0, 64);
  return clean.length >= 2 ? clean : 'admin';
}

export function oidcRoutes(ctx: AppContext) {
  const cfg = ctx.config.oidc;
  const publicUrl = ctx.config.publicUrl;

  let cached: Promise<oidc.Configuration> | undefined;
  /** Discovery is lazy and retried, so BMM starts even if the provider is down. */
  function provider(): Promise<oidc.Configuration> {
    if (!cfg) throw new HttpError(404, 'oidc_disabled', 'OIDC sign-in is not configured');
    if (!cached) {
      const insecure = cfg.issuer.startsWith('http://');
      cached = oidc
        .discovery(
          new URL(cfg.issuer),
          cfg.clientId,
          cfg.clientSecret,
          cfg.clientSecret ? undefined : oidc.None(),
          insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
        )
        .catch((err) => {
          cached = undefined;
          throw err;
        });
    }
    return cached;
  }

  const redirectUri = () => new URL('/api/v1/auth/oidc/callback', publicUrl).toString();

  return async (root: FastifyInstance) => {
    const app = root.withTypeProvider<ZodTypeProvider>();
    const tags = ['auth'];

    async function begin(req: FastifyRequest, intent: 'login' | 'link') {
      const config = await provider();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      await ctx.db.delete(oidcStates).where(lt(oidcStates.expiresAt, new Date()));
      await ctx.db.insert(oidcStates).values({
        state,
        codeVerifier,
        nonce,
        intent,
        userId: intent === 'link' ? (req.auth?.user.id ?? null) : null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      });
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri(),
        scope: (cfg as NonNullable<typeof cfg>).scopes,
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      });
    }

    app.get(
      '/auth/oidc/start',
      {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: {
          tags,
          summary: 'Begin OIDC sign-in',
          description: 'Open in a browser. Redirects to the identity provider.',
          response: { 302: z.null(), 404: ErrorSchema },
        },
      },
      async (req, reply) => reply.redirect((await begin(req, 'login')).toString()),
    );

    app.get(
      '/auth/oidc/link',
      {
        preHandler: requireSession(),
        schema: {
          tags,
          summary: 'Link the signed-in admin to an OIDC identity',
          description:
            'Open in a browser while signed in. Whoever signs in at the provider becomes the linked identity.',
          security: [{ session: [] }],
          response: { 302: z.null(), 401: ErrorSchema, 404: ErrorSchema },
        },
      },
      async (req, reply) => reply.redirect((await begin(req, 'link')).toString()),
    );

    app.delete(
      '/auth/oidc/link',
      {
        preHandler: requireSession(),
        schema: {
          tags,
          summary: 'Remove the OIDC link',
          description: 'Refused if no password is set, since that would lock the admin out.',
          security: [{ session: [] }],
          response: { 204: z.null(), 400: ErrorSchema, 401: ErrorSchema },
        },
      },
      async (req, reply) => {
        const a = req.auth as NonNullable<typeof req.auth>;
        if (!a.user.passwordHash || !ctx.config.passwordLogin) {
          throw badRequest('Set a password and keep password sign-in on before unlinking, or nobody could sign in');
        }
        await ctx.db
          .update(users)
          .set({ oidcIssuer: null, oidcSubject: null, updatedAt: new Date() })
          .where(eq(users.id, a.user.id));
        await audit(ctx, req, { action: 'auth.oidc_unlinked' });
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/auth/oidc/callback',
      {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: { tags, summary: 'OIDC redirect target', hide: true },
      },
      async (req, reply) => {
        const fail = async (code: string, to = '/login') => {
          await audit(ctx, req, {
            action: 'auth.login_failed',
            metadata: { method: 'oidc', reason: code },
            actor: { type: 'anonymous' },
          });
          return reply.redirect(`${to}?error=${encodeURIComponent(code)}`);
        };
        if (!cfg || !publicUrl) return fail('oidc_disabled');
        const query = req.query as Record<string, string | undefined>;
        const state = query.state;
        if (!state) return fail('oidc_state');
        const [pending] = await ctx.db.delete(oidcStates).where(eq(oidcStates.state, state)).returning();
        if (!pending || pending.expiresAt < new Date()) return fail('oidc_state');

        let claims: oidc.IDToken;
        let email: string | undefined;
        let emailVerified: boolean | undefined;
        try {
          const config = await provider();
          const tokens = await oidc.authorizationCodeGrant(config, new URL(req.url, publicUrl.origin), {
            pkceCodeVerifier: pending.codeVerifier,
            expectedState: state,
            expectedNonce: pending.nonce,
          });
          const c = tokens.claims();
          if (!c) return fail('oidc_no_id_token');
          claims = c;
          email = typeof c.email === 'string' ? c.email : undefined;
          emailVerified = typeof c.email_verified === 'boolean' ? c.email_verified : undefined;
          if (!email && tokens.access_token) {
            try {
              const info = await oidc.fetchUserInfo(config, tokens.access_token, c.sub);
              email = info.email;
              emailVerified = info.email_verified;
              claims = { ...c, preferred_username: c.preferred_username ?? info.preferred_username };
            } catch {
              // Email is optional; the subject alone identifies the person.
            }
          }
        } catch (err) {
          req.log.warn({ err }, 'OIDC code exchange failed');
          return fail('oidc_exchange');
        }
        const issuer = claims.iss;
        const subject = claims.sub;
        const emailLc = email?.toLowerCase();

        if (pending.intent === 'link') {
          if (req.auth?.via !== 'session' || req.auth.user.id !== pending.userId) {
            return fail('oidc_link_session', '/settings');
          }
          await ctx.db
            .update(users)
            .set({
              oidcIssuer: issuer,
              oidcSubject: subject,
              email: req.auth.user.email ?? emailLc ?? null,
              updatedAt: new Date(),
            })
            .where(eq(users.id, req.auth.user.id));
          await audit(ctx, req, { action: 'auth.oidc_linked', metadata: { issuer, subject } });
          return reply.redirect('/settings?linked=1');
        }

        const matchesOperatorAllowlist =
          (cfg.allowedSubject !== undefined && cfg.allowedSubject === subject) ||
          (cfg.allowedEmail !== undefined && emailLc === cfg.allowedEmail && emailVerified !== false);

        try {
          let createdNow = false;
          const user = await ctx.db.transaction(async (tx) => {
            const [linked] = await tx
              .select()
              .from(users)
              .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
              .limit(1);
            if (linked) return linked;

            const [n] = await tx.select({ n: count() }).from(users);
            if ((n?.n ?? 0) === 0) {
              // Fresh instance: the first person through SSO becomes the admin,
              // unless the operator asked for a setup token. A token cannot be
              // typed into an SSO redirect, so then the allowlist must match.
              if (ctx.config.setupToken && !matchesOperatorAllowlist) throw new OidcDenied('oidc_setup_token');
              const [created] = await tx
                .insert(users)
                .values({
                  id: uuidv7(),
                  username: usernameFrom(claims),
                  email: emailLc ?? null,
                  oidcIssuer: issuer,
                  oidcSubject: subject,
                })
                .returning();
              if (!created) throw new Error('insert returned nothing');
              createdNow = true;
              return created;
            }

            // An admin exists and this identity is not linked to it. Being
            // able to sign in at the provider is not proof of being the admin,
            // so only an identity the operator named in the environment is
            // linked automatically. Otherwise: sign in with the password and
            // link from Settings.
            if (!matchesOperatorAllowlist) throw new OidcDenied('oidc_not_linked');
            const [unlinked] = await tx.select().from(users).limit(1);
            if (!unlinked || unlinked.oidcSubject) throw new OidcDenied('oidc_not_linked');
            const [updated] = await tx
              .update(users)
              .set({
                oidcIssuer: issuer,
                oidcSubject: subject,
                email: unlinked.email ?? emailLc ?? null,
                updatedAt: new Date(),
              })
              .where(eq(users.id, unlinked.id))
              .returning();
            if (!updated) throw new Error('update returned nothing');
            return updated;
          });
          // Written after the transaction: the audit log uses its own connection.
          if (createdNow) {
            await audit(ctx, req, {
              action: 'auth.setup',
              targetType: 'user',
              targetId: user.id,
              metadata: { method: 'oidc' },
              actor: { type: 'user', id: user.id, label: user.username },
            });
          }
          await startSession(ctx, req, reply, user.id);
          await audit(ctx, req, {
            action: 'auth.login',
            metadata: { method: 'oidc' },
            actor: { type: 'user', id: user.id, label: user.username },
          });
          return reply.redirect('/');
        } catch (err) {
          if (err instanceof OidcDenied) return fail(err.code);
          throw err;
        }
      },
    );
  };
}
