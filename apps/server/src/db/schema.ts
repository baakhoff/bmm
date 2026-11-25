import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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

/** A persona: the owner of accounts, media and posts. */
export const profiles = pgTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    color: text('color').notNull().default('#1f5a41'),
    notes: text('notes').notNull().default(''),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('profiles_user_idx').on(t.userId)],
);

/** The developer app credentials for one network. The secret is encrypted. */
export const networkApps = pgTable('network_apps', {
  network: text('network').primaryKey(),
  clientId: text('client_id').notNull(),
  clientSecretEnc: text('client_secret_enc').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    network: text('network').$type<'x' | 'instagram'>().notNull(),
    externalId: text('external_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    tokenExpiresAt: ts('token_expires_at'),
    tokenRefreshedAt: ts('token_refreshed_at').notNull().defaultNow(),
    scopes: text('scopes').notNull().default(''),
    status: text('status').$type<'active' | 'needs_reauth'>().notNull().default('active'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // One network account belongs to one persona; that is the point of personas.
    uniqueIndex('accounts_network_external_uq').on(t.network, t.externalId),
    index('accounts_profile_idx').on(t.profileId),
  ],
);

/** In-flight "connect an account" redirects. Short-lived, deleted when used. */
export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  network: text('network').notNull(),
  profileId: text('profile_id').notNull(),
  userId: text('user_id').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const media = pgTable(
  'media',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'image'>().notNull(),
    mime: text('mime').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    filename: text('filename').notNull(),
    alt: text('alt').notNull().default(''),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('media_profile_idx').on(t.profileId)],
);

export const posts = pgTable(
  'posts',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    text: text('text').notNull().default(''),
    status: text('status')
      .$type<'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed'>()
      .notNull()
      .default('draft'),
    scheduledAt: ts('scheduled_at'),
    /** Who made it: a username, or "token:<name>". */
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('posts_profile_idx').on(t.profileId), index('posts_due_idx').on(t.status, t.scheduledAt)],
);

export const postMedia = pgTable(
  'post_media',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    // No cascade: media a post uses cannot be deleted from under it.
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.position] })],
);

/** One account a post goes to, with its own outcome. */
export const postTargets = pgTable(
  'post_targets',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Order as given when the post was written, so results read back the same way. */
    position: integer('position').notNull().default(0),
    text: text('text'),
    status: text('status')
      .$type<'pending' | 'publishing' | 'retrying' | 'published' | 'failed'>()
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    claimedAt: ts('claimed_at'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    error: text('error'),
    publishedAt: ts('published_at'),
  },
  (t) => [uniqueIndex('post_targets_uq').on(t.postId, t.accountId), index('post_targets_status_idx').on(t.status)],
);
