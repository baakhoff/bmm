import { z } from 'zod';

/**
 * Scopes an API token can carry. `admin` implies every other scope.
 * Resource scopes are declared up front so tokens minted today keep their
 * meaning as the matching resources land.
 */
export const SCOPES = [
  'admin',
  'profiles:read',
  'profiles:write',
  'accounts:read',
  'accounts:write',
  'posts:read',
  'posts:write',
  'media:read',
  'media:write',
  'analytics:read',
  'inbox:read',
  'inbox:write',
  'audit:read',
  'tokens:read',
  'tokens:write',
] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  admin: 'Everything, including instance settings',
  'profiles:read': 'List and read profiles',
  'profiles:write': 'Create, change and delete profiles',
  'accounts:read': 'List connected social accounts',
  'accounts:write': 'Connect and disconnect social accounts',
  'posts:read': 'Read drafts, scheduled and published posts',
  'posts:write': 'Create, schedule, publish and delete posts',
  'media:read': 'Read the media library',
  'media:write': 'Upload and delete media',
  'analytics:read': 'Read analytics',
  'inbox:read': 'Read comments and direct messages',
  'inbox:write': 'Reply to comments and direct messages',
  'audit:read': 'Read the audit log',
  'tokens:read': 'List API tokens',
  'tokens:write': 'Create and revoke API tokens',
};

export function hasScope(granted: readonly string[], needed: Scope): boolean {
  return granted.includes('admin') || granted.includes(needed);
}

export const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ErrorSchema>;

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  hasPassword: z.boolean(),
  oidcLinked: z.boolean(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const AuthStatusSchema = z.object({
  setupRequired: z.boolean(),
  setupTokenRequired: z.boolean(),
  passwordLoginEnabled: z.boolean(),
  oidc: z.object({ enabled: z.boolean(), name: z.string() }),
  version: z.string(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

const username = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._@-]+$/, 'Letters, digits and . _ @ - only');
const password = z.string().min(10, 'At least 10 characters').max(256);

export const SetupRequestSchema = z.object({
  username,
  password,
  email: z.email().optional(),
  setupToken: z.string().optional(),
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().max(256).optional(),
  newPassword: password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const MeSchema = z.object({
  user: UserSchema,
  via: z.enum(['session', 'token']),
  scopes: z.array(z.string()),
});
export type Me = z.infer<typeof MeSchema>;

export const ApiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ScopeSchema),
  profileIds: z.array(z.string()).nullable(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const CreateApiTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ScopeSchema).min(1),
  /** null or omitted: every profile. A list: only those profiles. */
  profileIds: z.array(z.string()).nullable().optional(),
  /** Days until the token expires. Omitted: never. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequestSchema>;

export const CreatedApiTokenSchema = ApiTokenSchema.extend({
  /** The secret. Returned once, at creation, and never again. */
  token: z.string(),
});
export type CreatedApiToken = z.infer<typeof CreatedApiTokenSchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorType: z.enum(['user', 'token', 'system', 'anonymous']),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().optional(),
  action: z.string().optional(),
});

export const AuditPageSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextBefore: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

export const SystemVersionSchema = z.object({
  /** What this instance runs. A release is `1.2.3`; a build from main is `edge`. */
  version: z.string(),
  /** False when the operator turned the check off. */
  checkEnabled: z.boolean(),
  latestVersion: z.string().nullable(),
  /** null: unknown, because the check is off, has not succeeded, or this is not a release build. */
  updateAvailable: z.boolean().nullable(),
  releaseUrl: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type SystemVersion = z.infer<typeof SystemVersionSchema>;

// ---------------------------------------------------------------------------
// Profiles, networks, accounts
// ---------------------------------------------------------------------------

export const NETWORKS = ['x', 'instagram'] as const;
export const NetworkSchema = z.enum(NETWORKS);
export type Network = z.infer<typeof NetworkSchema>;
export const NETWORK_LABELS: Record<Network, string> = { x: 'X', instagram: 'Instagram' };

const timezone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Not an IANA time zone, e.g. Europe/Belgrade');

export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** IANA zone the persona lives in; schedules are shown in it. */
  timezone: z.string(),
  color: z.string(),
  notes: z.string(),
  accountCount: z.number().int(),
  createdAt: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CreateProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: timezone.default('UTC'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'A hex colour like #1f5a41')
    .default('#1f5a41'),
  notes: z.string().max(2000).default(''),
});
export type CreateProfileRequest = z.input<typeof CreateProfileRequestSchema>;
export const UpdateProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: timezone.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  notes: z.string().max(2000).optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

/** The developer app BMM uses to talk to one network. One per instance. */
export const NetworkAppSchema = z.object({
  network: NetworkSchema,
  configured: z.boolean(),
  clientId: z.string().nullable(),
  /** Register exactly this at the network. null: BMM_PUBLIC_URL is not set. */
  redirectUri: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type NetworkApp = z.infer<typeof NetworkAppSchema>;

export const NetworksStatusSchema = z.object({
  apps: z.array(NetworkAppSchema),
  /** Instagram downloads images from this address. null: not configured, Instagram cannot publish. */
  publicMediaUrl: z.string().nullable(),
});
export type NetworksStatus = z.infer<typeof NetworksStatusSchema>;

export const SetNetworkAppRequestSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
});
export type SetNetworkAppRequest = z.infer<typeof SetNetworkAppRequestSchema>;

export const AccountSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  network: NetworkSchema,
  externalId: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** needs_reauth: the network revoked or expired our access; connect it again. */
  status: z.enum(['active', 'needs_reauth']),
  connectedAt: z.string(),
});
export type Account = z.infer<typeof AccountSchema>;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MediaSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  kind: z.enum(['image']),
  mime: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  filename: z.string(),
  alt: z.string(),
  /** Fetch with the same credentials as any other API call. */
  contentUrl: z.string(),
  createdAt: z.string(),
});
export type Media = z.infer<typeof MediaSchema>;

export const ImportMediaRequestSchema = z
  .object({
    profileId: z.string(),
    /** A public http(s) address BMM downloads the image from. */
    url: z.url().optional(),
    /** The image itself, base64-encoded. */
    dataBase64: z.string().optional(),
    filename: z.string().max(200).optional(),
    alt: z.string().max(1000).default(''),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.dataBase64), 'Give exactly one of url and dataBase64');
export type ImportMediaRequest = z.input<typeof ImportMediaRequestSchema>;

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed'] as const;
export const PostStatusSchema = z.enum(POST_STATUSES);
export type PostStatus = z.infer<typeof PostStatusSchema>;

export const TARGET_STATUSES = ['pending', 'publishing', 'retrying', 'published', 'failed'] as const;
export const TargetStatusSchema = z.enum(TARGET_STATUSES);

export const PostTargetSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  network: NetworkSchema,
  username: z.string(),
  /** Text for this account only. null: the post's text. */
  text: z.string().nullable(),
  status: TargetStatusSchema,
  attempts: z.number().int(),
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  error: z.string().nullable(),
  publishedAt: z.string().nullable(),
});
export type PostTarget = z.infer<typeof PostTargetSchema>;

export const PostSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  text: z.string(),
  status: PostStatusSchema,
  scheduledAt: z.string().nullable(),
  media: z.array(MediaSchema),
  targets: z.array(PostTargetSchema),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Post = z.infer<typeof PostSchema>;

const targetInput = z.object({
  accountId: z.string(),
  text: z.string().max(10000).nullable().optional(),
});

const postContent = {
  text: z.string().max(10000).default(''),
  mediaIds: z.array(z.string()).max(10).default([]),
  targets: z.array(targetInput).max(20).default([]),
};

export const ValidatePostRequestSchema = z.object({ profileId: z.string(), ...postContent });
export type ValidatePostRequest = z.input<typeof ValidatePostRequestSchema>;

export const CreatePostRequestSchema = z.object({
  profileId: z.string(),
  ...postContent,
  /**
   * draft: save only. schedule: publish at scheduledAt. publish: publish now.
   * schedule and publish are refused if validation finds an error.
   */
  action: z.enum(['draft', 'schedule', 'publish']).default('draft'),
  /** ISO 8601 with an offset, e.g. 2026-12-01T09:30:00+01:00. Required for schedule. */
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreatePostRequest = z.input<typeof CreatePostRequestSchema>;

export const UpdatePostRequestSchema = z.object({
  text: z.string().max(10000).optional(),
  mediaIds: z.array(z.string()).max(10).optional(),
  targets: z.array(targetInput).max(20).optional(),
  action: z.enum(['draft', 'schedule', 'publish']).optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
});
export type UpdatePostRequest = z.infer<typeof UpdatePostRequestSchema>;

export const ValidationIssueSchema = z.object({
  /** error: the network would refuse it. warning: it would publish, but you should know. */
  level: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  accountId: z.string().nullable(),
  network: NetworkSchema.nullable(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(ValidationIssueSchema),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ListPostsQuerySchema = z.object({
  profileId: z.string().optional(),
  status: PostStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

export const PostPageSchema = z.object({ items: z.array(PostSchema), nextBefore: z.string().nullable() });
export type PostPage = z.infer<typeof PostPageSchema>;
