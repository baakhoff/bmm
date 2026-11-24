import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  BMM_HOST: z.string().default('0.0.0.0'),
  BMM_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** The URL people open BMM at, e.g. https://bmm.example.com. Needed for OIDC. */
  BMM_PUBLIC_URL: optional,
  /** postgres://... for a real database, pglite://<dir> for the embedded one, pglite://memory for tests. */
  DATABASE_URL: z.string().default('pglite://./data/pg'),
  /** If set, creating the first admin requires this value. */
  BMM_SETUP_TOKEN: optional,
  BMM_PASSWORD_LOGIN: bool(true),
  BMM_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Trust X-Forwarded-* headers. Turn on behind an ingress or reverse proxy. */
  BMM_TRUST_PROXY: bool(false),
  BMM_OIDC_ISSUER: optional,
  BMM_OIDC_CLIENT_ID: optional,
  BMM_OIDC_CLIENT_SECRET: optional,
  BMM_OIDC_NAME: z.string().default('SSO'),
  BMM_OIDC_SCOPES: z.string().default('openid profile email'),
  /** Lets an identity with this verified email sign in as the existing admin. */
  BMM_OIDC_ALLOWED_EMAIL: optional,
  /** Lets the identity with this `sub` sign in as the existing admin. */
  BMM_OIDC_ALLOWED_SUBJECT: optional,
  /** Directory holding the built web UI. Unset: API only. */
  BMM_WEB_DIR: optional,
  BMM_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  host: string;
  port: number;
  publicUrl: URL | undefined;
  databaseUrl: string;
  setupToken: string | undefined;
  passwordLogin: boolean;
  sessionTtlMs: number;
  trustProxy: boolean;
  oidc:
    | {
        issuer: string;
        clientId: string;
        clientSecret: string | undefined;
        name: string;
        scopes: string;
        allowedEmail: string | undefined;
        allowedSubject: string | undefined;
      }
    | undefined;
  webDir: string | undefined;
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const oidcConfigured = Boolean(e.BMM_OIDC_ISSUER && e.BMM_OIDC_CLIENT_ID);
  if ((e.BMM_OIDC_ISSUER || e.BMM_OIDC_CLIENT_ID) && !oidcConfigured) {
    throw new Error('OIDC needs both BMM_OIDC_ISSUER and BMM_OIDC_CLIENT_ID');
  }
  if (oidcConfigured && !e.BMM_PUBLIC_URL) {
    throw new Error('OIDC needs BMM_PUBLIC_URL, the address the identity provider redirects back to');
  }
  if (!e.BMM_PASSWORD_LOGIN && !oidcConfigured) {
    throw new Error('BMM_PASSWORD_LOGIN=false needs OIDC configured, or nobody could sign in');
  }
  return {
    host: e.BMM_HOST,
    port: e.BMM_PORT,
    publicUrl: e.BMM_PUBLIC_URL ? new URL(e.BMM_PUBLIC_URL) : undefined,
    databaseUrl: e.DATABASE_URL,
    setupToken: e.BMM_SETUP_TOKEN,
    passwordLogin: e.BMM_PASSWORD_LOGIN,
    sessionTtlMs: e.BMM_SESSION_TTL_DAYS * 86_400_000,
    trustProxy: e.BMM_TRUST_PROXY,
    oidc: oidcConfigured
      ? {
          issuer: e.BMM_OIDC_ISSUER as string,
          clientId: e.BMM_OIDC_CLIENT_ID as string,
          clientSecret: e.BMM_OIDC_CLIENT_SECRET,
          name: e.BMM_OIDC_NAME,
          scopes: e.BMM_OIDC_SCOPES,
          allowedEmail: e.BMM_OIDC_ALLOWED_EMAIL?.toLowerCase(),
          allowedSubject: e.BMM_OIDC_ALLOWED_SUBJECT,
        }
      : undefined,
    webDir: e.BMM_WEB_DIR,
    logLevel: e.BMM_LOG_LEVEL,
  };
}
