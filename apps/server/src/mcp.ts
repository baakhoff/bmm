import {
  CreatePostRequestSchema,
  CreateProfileRequestSchema,
  ImportMediaRequestSchema,
  PostStatusSchema,
  UpdatePostRequestSchema,
  UpdateProfileRequestSchema,
  ValidatePostRequestSchema,
} from '@bmm/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { auditLog } from './db/schema.js';
import { forbidden, HttpError } from './lib/errors.js';
import { disconnectAccount, listAccounts } from './services/accounts.js';
import { type Actor, actorOf, need } from './services/actor.js';
import { deleteMedia, getMedia, importMedia, listMedia } from './services/media.js';
import { networksStatus } from './services/networks.js';
import { createPost, deletePost, getPost, listPosts, retryPost, updatePost, validatePost } from './services/posts.js';
import { createProfile, deleteProfile, getProfile, listProfiles, updateProfile } from './services/profiles.js';

const INSTRUCTIONS = `BMM (Better Marketing Management) schedules and publishes social media posts.

How things fit together:
- A profile is a persona. It owns connected accounts (X, Instagram), a media library and posts. Nothing is shared between profiles.
- A post belongs to one profile and goes to one or more of that profile's accounts ("targets").

The order that works:
1. whoami, to see which scopes and profiles this token may use.
2. list_profiles, then list_accounts for the profile, to get the account ids to target.
3. import_media for each image, if the post has any. Instagram cannot publish without an image.
4. validate_post with the exact text, mediaIds and targets. Fix every issue of level "error"; tell the person about warnings.
5. create_post with action "schedule" (and scheduledAt) or "publish". A post with validation errors is refused.
6. get_post afterwards to read the outcome per account: a link when published, the network's error when not.

Things to know:
- Publishing is real and public. Nothing here asks for confirmation; if the person has not clearly asked for a post to go out, create it with action "draft" and say so.
- Accounts are connected by a person in the BMM web UI, never through these tools. If an account's status is "needs_reauth", ask the person to connect it again there.
- Times are ISO 8601 with an offset. Each profile has a timezone; use it when the person says "9 in the morning".
- If an error says a post "may or may not have been published", do not retry until the person has checked the account, or it may be posted twice.
- Deleting a post here does not remove what was already published on the network.`;

function ok(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: (value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { result: value }) as Record<string, unknown>,
  };
}

function buildServer(ctx: AppContext, actor: Actor): McpServer {
  const server = new McpServer({ name: 'bmm', version: ctx.version }, { instructions: INSTRUCTIONS });

  /** Registers a tool whose failures come back as readable tool errors, not protocol errors. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; readOnly?: boolean; destructive?: boolean },
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: meta.readOnly ?? false,
          destructiveHint: meta.destructive ?? false,
          openWorldHint: !meta.readOnly,
        },
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return ok(await run(args));
        } catch (err) {
          if (err instanceof HttpError) {
            return { isError: true, content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }] };
          }
          if (err instanceof z.ZodError) {
            const text = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
            return { isError: true, content: [{ type: 'text' as const, text: `validation_failed: ${text}` }] };
          }
          ctx.log.error({ err, tool: name }, 'MCP tool failed');
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'internal: BMM hit an internal error. See the server log.' }],
          };
        }
        // biome-ignore lint/suspicious/noExplicitAny: the SDK's handler type depends on its own zod generics
      }) as any,
    );
  }

  tool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'The user this token acts as, its scopes, and the profiles it is limited to (null means all). Call this first.',
      readOnly: true,
    },
    {},
    async () => ({
      username: actor.auth.user.username,
      via: actor.auth.via,
      tokenName: actor.auth.tokenName ?? null,
      scopes: actor.auth.scopes,
      profileIds: actor.auth.profileIds,
      serverVersion: ctx.version,
    }),
  );

  // -- Profiles ------------------------------------------------------------
  tool(
    'list_profiles',
    {
      title: 'List profiles',
      description: 'Every profile (persona) this token may use, with its timezone and number of connected accounts.',
      readOnly: true,
    },
    {},
    async () => ({ items: await listProfiles(ctx, actor) }),
  );
  tool(
    'get_profile',
    {
      title: 'Get a profile',
      description: 'One profile by id: its name, timezone, notes and how many accounts are connected.',
      readOnly: true,
    },
    { profileId: z.string() },
    async (a) => getProfile(ctx, actor, a.profileId),
  );
  tool(
    'create_profile',
    {
      title: 'Create a profile',
      description:
        'Creates a new persona. It starts with no accounts: a person connects those in the web UI. Not available to a profile-limited token.',
    },
    CreateProfileRequestSchema.shape,
    async (a) => createProfile(ctx, actor, a),
  );
  tool(
    'update_profile',
    {
      title: 'Change a profile',
      description: 'Changes the name, timezone, colour or notes of a profile. Only the fields given are changed.',
    },
    { profileId: z.string(), ...UpdateProfileRequestSchema.shape },
    async ({ profileId, ...rest }) => updateProfile(ctx, actor, profileId, rest),
  );
  tool(
    'delete_profile',
    {
      title: 'Delete a profile',
      description:
        'Permanently deletes a profile with its connected accounts, media and posts in BMM. Scheduled posts will not go out. Nothing is deleted on the networks. Only do this when the person asked for exactly this profile to be deleted.',
      destructive: true,
    },
    { profileId: z.string() },
    async (a) => {
      await deleteProfile(ctx, actor, a.profileId);
      return { deleted: a.profileId };
    },
  );

  // -- Networks and accounts -----------------------------------------------
  tool(
    'list_networks',
    {
      title: 'Which networks are set up',
      description:
        'Per network: whether the instance has a developer app configured. Also whether a public media address exists, which Instagram needs to publish. Use it to explain why an account cannot be connected or a post cannot be validated.',
      readOnly: true,
    },
    {},
    async () => networksStatus(ctx, actor),
  );
  tool(
    'list_accounts',
    {
      title: 'List connected accounts',
      description:
        'The social accounts connected to a profile (or to every profile this token may use). The ids are what a post targets. status "needs_reauth" means a person must connect it again in the web UI.',
      readOnly: true,
    },
    { profileId: z.string().optional() },
    async (a) => ({ items: await listAccounts(ctx, actor, a.profileId) }),
  );
  tool(
    'disconnect_account',
    {
      title: 'Disconnect an account',
      description:
        'Forgets an account and its access in BMM. Its scheduled posts lose this target. Connecting it again needs a person in the web UI, so only do this when asked.',
      destructive: true,
    },
    { accountId: z.string() },
    async (a) => {
      await disconnectAccount(ctx, actor, a.accountId);
      return { disconnected: a.accountId };
    },
  );

  // -- Media ---------------------------------------------------------------
  tool(
    'import_media',
    {
      title: 'Add an image to a profile',
      description:
        "Adds an image to a profile's media library and returns its id for use in mediaIds. Give either url (a public http(s) address; private-network addresses are refused) or dataBase64. JPEG, PNG or WebP up to 20 MB. Always set alt: a short description for people who cannot see the image.",
    },
    ImportMediaRequestSchema.shape,
    async (a) => importMedia(ctx, actor, a),
  );
  tool(
    'list_media',
    {
      title: 'List media',
      description:
        "A profile's images, newest first, with dimensions. Check here before importing the same image again.",
      readOnly: true,
    },
    { profileId: z.string() },
    async (a) => ({ items: await listMedia(ctx, actor, a.profileId) }),
  );
  tool(
    'get_media',
    {
      title: 'Get a media item',
      description: 'One image from the media library: its dimensions, file size, type and alt text.',
      readOnly: true,
    },
    { mediaId: z.string() },
    async (a) => getMedia(ctx, actor, a.mediaId),
  );
  tool(
    'delete_media',
    {
      title: 'Delete an image',
      description: 'Removes an image from the library. Refused while a post uses it.',
      destructive: true,
    },
    { mediaId: z.string() },
    async (a) => {
      await deleteMedia(ctx, actor, a.mediaId);
      return { deleted: a.mediaId };
    },
  );

  // -- Posts ---------------------------------------------------------------
  tool(
    'validate_post',
    {
      title: 'Check a post before saving it',
      description:
        'Checks text, images and targets against each chosen network\'s rules without saving anything. Returns issues: level "error" would be refused by the network and blocks scheduling; level "warning" publishes but the person should hear about it. Call this before create_post with action schedule or publish.',
      readOnly: true,
    },
    ValidatePostRequestSchema.shape,
    async (a) => validatePost(ctx, actor, a),
  );
  tool(
    'create_post',
    {
      title: 'Create, schedule or publish a post',
      description:
        'Creates a post in one profile for one or more of its accounts. action "draft" only saves it. action "schedule" publishes at scheduledAt (ISO 8601 with offset). action "publish" publishes now, publicly and for real. targets[].text overrides the text for one account, for example a shorter version for X. Run validate_post first; a post with errors is refused with the reasons.',
    },
    CreatePostRequestSchema.shape,
    async (a) => createPost(ctx, actor, a),
  );
  tool(
    'update_post',
    {
      title: 'Change a post that has not gone out',
      description:
        'Changes a draft or scheduled post; only the fields given change, and a given mediaIds or targets list replaces the old one. action "draft" takes it off the schedule, "schedule" (with scheduledAt) moves or sets the time, "publish" sends it now.',
    },
    { postId: z.string(), ...UpdatePostRequestSchema.shape },
    async ({ postId, ...rest }) => updatePost(ctx, actor, postId, rest),
  );
  tool(
    'get_post',
    {
      title: 'Get a post and its outcome',
      description:
        'A post with, per target account, its status, the link to the published post, or the error the network gave. Use after publishing to report what happened.',
      readOnly: true,
    },
    { postId: z.string() },
    async (a) => getPost(ctx, actor, a.postId),
  );
  tool(
    'list_posts',
    {
      title: 'List posts',
      description:
        'Posts newest first, optionally for one profile or one status (draft, scheduled, publishing, published, partial, failed). Pass nextBefore from a result as before to get the next page.',
      readOnly: true,
    },
    {
      profileId: z.string().optional(),
      status: PostStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      before: z.string().optional(),
    },
    async (a) => listPosts(ctx, actor, a),
  );
  tool(
    'retry_post',
    {
      title: 'Retry the failed accounts of a post',
      description:
        "Tries again for accounts where a post failed; accounts that published are untouched. Read the target's error first. If it says the post may have been published, do not retry until the person has checked the account.",
    },
    { postId: z.string() },
    async (a) => retryPost(ctx, actor, a.postId),
  );
  tool(
    'delete_post',
    {
      title: 'Delete a post',
      description:
        'Deletes a post in BMM; a scheduled one will not go out. What was already published stays on the network and must be removed there.',
      destructive: true,
    },
    { postId: z.string() },
    async (a) => {
      await deletePost(ctx, actor, a.postId);
      return { deleted: a.postId };
    },
  );

  // -- Audit ---------------------------------------------------------------
  tool(
    'list_audit_log',
    {
      title: 'Read the audit log',
      description:
        'What happened on this instance, newest first: sign-ins, changes, and every publish attempt with its result. Filter by action, such as post.published or post.failed.',
      readOnly: true,
    },
    {
      limit: z.number().int().min(1).max(100).default(30),
      action: z.string().optional(),
      before: z.string().optional(),
    },
    async (a) => {
      need(actor, 'audit:read');
      if (actor.auth.profileIds !== null)
        throw forbidden('A profile-limited token cannot read the instance-wide audit log');
      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(a.before ? lt(auditLog.id, a.before) : undefined, a.action ? eq(auditLog.action, a.action) : undefined),
        )
        .orderBy(desc(auditLog.id))
        .limit(a.limit + 1);
      const page = rows.slice(0, a.limit);
      return {
        items: page.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actor: r.actorLabel ?? r.actorType,
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId,
          metadata: r.metadata,
        })),
        nextBefore: rows.length > a.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );

  return server;
}

/**
 * The MCP endpoint, at /mcp, over Streamable HTTP. Stateless: every request
 * carries its API token and gets a fresh server bound to that token's rights,
 * so there is no session to steal and any replica can answer.
 */
export function registerMcp(app: FastifyInstance, ctx: AppContext): void {
  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    if (req.auth?.via !== 'token') {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="bmm"')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Send an API token: Authorization: Bearer bmm_...' },
          id: null,
        });
    }
    const actor = actorOf(req);
    const server = buildServer(ctx, actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (
    _req: unknown,
    reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } } },
  ) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'This MCP endpoint is stateless: use POST.' },
        id: null,
      });
  app.get('/mcp', { schema: { hide: true } }, notAllowed as never);
  app.delete('/mcp', { schema: { hide: true } }, notAllowed as never);
}
