import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * One row today: the superadmin. Every owned table still carries user_id so
 * multi-user is an addition later, not a migration of meaning.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email'),
    passwordHash: text('password_hash'),
    oidcIssuer: text('oidc_issuer'),
    oidcSubject: text('oidc_subject'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    uniqueIndex('users_oidc_uq').on(t.oidcIssuer, t.oidcSubject),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the secret, kept so a token can be recognised in a list. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    /** null: every profile. */
    profileIds: jsonb('profile_ids').$type<string[] | null>(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_tokens_hash_uq').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    /** UUIDv7, so ordering by id is ordering by time. */
    id: text('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type').$type<'user' | 'token' | 'system' | 'anonymous'>().notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('audit_action_idx').on(t.action)],
);

/** In-flight OIDC logins. Short-lived, deleted when used. */
export const oidcStates = pgTable('oidc_states', {
  state: text('state').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  intent: text('intent').$type<'login' | 'link'>().notNull(),
  userId: text('user_id'),
  expiresAt: ts('expires_at').notNull(),
});
