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
