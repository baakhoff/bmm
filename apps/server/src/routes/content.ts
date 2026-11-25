import {
  AccountSchema,
  CreatePostRequestSchema,
  CreateProfileRequestSchema,
  ErrorSchema,
  ImportMediaRequestSchema,
  ListPostsQuerySchema,
  MediaSchema,
  NetworkSchema,
  NetworksStatusSchema,
  PostPageSchema,
  PostSchema,
  ProfileSchema,
  SetNetworkAppRequestSchema,
  UpdatePostRequestSchema,
  UpdateProfileRequestSchema,
  ValidatePostRequestSchema,
  ValidationResultSchema,
} from '@bmm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { beginConnect, completeConnect, disconnectAccount, listAccounts } from '../services/accounts.js';
import { actorOf } from '../services/actor.js';
import {
  addMedia,
  deleteMedia,
  getMedia,
  importMedia,
  listMedia,
  MAX_UPLOAD_BYTES,
  mediaContent,
} from '../services/media.js';
import { networksStatus, removeNetworkApp, setNetworkApp } from '../services/networks.js';
import { createPost, deletePost, getPost, listPosts, retryPost, updatePost, validatePost } from '../services/posts.js';
import { createProfile, deleteProfile, getProfile, listProfiles, updateProfile } from '../services/profiles.js';

const security: Record<string, string[]>[] = [{ bearer: [] }, { session: [] }];
const idParam = z.object({ id: z.string() });
const errors = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema };

export function contentRoutes(ctx: AppContext) {
  return async (root: FastifyInstance) => {
    const app = root.withTypeProvider<ZodTypeProvider>();
    const auth = requireAuth();

    // -- Profiles ----------------------------------------------------------

    app.get(
      '/profiles',
      {
        preHandler: auth,
        schema: {
          tags: ['profiles'],
          security,
          summary: 'List profiles',
          description:
            'A profile is a persona: it owns accounts, media and posts. A profile-limited token sees only its own.',
          response: { 200: z.object({ items: z.array(ProfileSchema) }), ...errors },
        },
      },
      async (req) => ({ items: await listProfiles(ctx, actorOf(req)) }),
    );

    app.post(
      '/profiles',
      {
        preHandler: auth,
        schema: {
          tags: ['profiles'],
          security,
          summary: 'Create a profile',
          body: CreateProfileRequestSchema,
          response: { 201: ProfileSchema, ...errors },
        },
      },
      async (req, reply) => reply.code(201).send(await createProfile(ctx, actorOf(req), req.body)),
    );

    app.get(
      '/profiles/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['profiles'],
          security,
          summary: 'Get a profile',
          params: idParam,
          response: { 200: ProfileSchema, ...errors },
        },
      },
      async (req) => getProfile(ctx, actorOf(req), req.params.id),
    );

    app.patch(
      '/profiles/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['profiles'],
          security,
          summary: 'Change a profile',
          params: idParam,
          body: UpdateProfileRequestSchema,
          response: { 200: ProfileSchema, ...errors },
        },
      },
      async (req) => updateProfile(ctx, actorOf(req), req.params.id, req.body),
    );

    app.delete(
      '/profiles/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['profiles'],
          security,
          summary: 'Delete a profile',
          description: 'Deletes its accounts, media and posts here. Nothing is deleted on the networks.',
          params: idParam,
          response: { 204: z.null(), ...errors },
        },
      },
      async (req, reply) => {
        await deleteProfile(ctx, actorOf(req), req.params.id);
        return reply.code(204).send(null);
      },
    );

    // -- Networks and accounts ---------------------------------------------

    app.get(
      '/networks',
      {
        preHandler: auth,
        schema: {
          tags: ['accounts'],
          security,
          summary: 'Which networks are set up',
          description:
            'Per network: whether a developer app is configured and the redirect URI to register there. Also the public media address Instagram needs.',
          response: { 200: NetworksStatusSchema, ...errors },
        },
      },
      async (req) => networksStatus(ctx, actorOf(req)),
    );

    app.put(
      '/networks/:network/app',
      {
        preHandler: auth,
        schema: {
          tags: ['accounts'],
          security,
          summary: 'Set the developer app for a network',
          description: 'Needs the admin scope. The secret is stored encrypted and never returned.',
          params: z.object({ network: NetworkSchema }),
          body: SetNetworkAppRequestSchema,
          response: { 204: z.null(), ...errors },
        },
      },
      async (req, reply) => {
        await setNetworkApp(ctx, actorOf(req), req.params.network, req.body);
        return reply.code(204).send(null);
      },
    );

    app.delete(
      '/networks/:network/app',
      {
        preHandler: auth,
        schema: {
          tags: ['accounts'],
          security,
          summary: 'Remove the developer app for a network',
          params: z.object({ network: NetworkSchema }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (req, reply) => {
        await removeNetworkApp(ctx, actorOf(req), req.params.network);
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/accounts',
      {
        preHandler: auth,
        schema: {
          tags: ['accounts'],
          security,
          summary: 'List connected accounts',
          querystring: z.object({ profileId: z.string().optional() }),
          response: { 200: z.object({ items: z.array(AccountSchema) }), ...errors },
        },
      },
      async (req) => ({ items: await listAccounts(ctx, actorOf(req), req.query.profileId) }),
    );

    app.delete(
      '/accounts/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['accounts'],
          security,
          summary: 'Disconnect an account',
          description: 'Forgets the account and its tokens. Its scheduled posts lose this target.',
          params: idParam,
          response: { 204: z.null(), ...errors },
        },
      },
      async (req, reply) => {
        await disconnectAccount(ctx, actorOf(req), req.params.id);
        return reply.code(204).send(null);
      },
    );

    app.get(
      '/profiles/:id/connect/:network',
      {
        preHandler: requireSession(),
        schema: {
          tags: ['accounts'],
          security: [{ session: [] }],
          summary: 'Connect an account to a profile',
          description:
            'Open in a browser while signed in. Redirects to the network, where a person approves the connection. An API token cannot do this: a person has to sign in at the network.',
          params: z.object({ id: z.string(), network: NetworkSchema }),
          response: { 302: z.null(), ...errors },
        },
      },
      async (req, reply) => {
        try {
          return reply.redirect(await beginConnect(ctx, actorOf(req), req.params.id, req.params.network));
        } catch (err) {
          if (err instanceof HttpError) {
            return reply.redirect(`/profiles/${req.params.id}?connect_error=${encodeURIComponent(err.message)}`);
          }
          throw err;
        }
      },
    );

    app.get(
      '/oauth/:network/callback',
      { schema: { hide: true, params: z.object({ network: NetworkSchema }) } },
      async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        try {
          if (!req.auth) throw new HttpError(401, 'unauthorized', 'Sign in to BMM first, then start connecting again.');
          const done = await completeConnect(ctx, actorOf(req), req.params.network, query);
          return reply.redirect(
            `/profiles/${done.profileId}?connected=${encodeURIComponent(`@${done.account.username}`)}`,
          );
        } catch (err) {
          if (err instanceof HttpError)
            return reply.redirect(`/profiles?connect_error=${encodeURIComponent(err.message)}`);
          throw err;
        }
      },
    );

    // -- Media -------------------------------------------------------------

    app.post(
      '/media',
      {
        preHandler: auth,
        schema: {
          tags: ['media'],
          security,
          summary: 'Upload an image',
          description:
            'multipart/form-data with the fields `profileId`, optional `alt`, then `file`. JPEG, PNG or WebP, up to 20 MB. To send JSON instead, use /media/import.',
          consumes: ['multipart/form-data'],
          response: { 201: MediaSchema, ...errors },
        },
      },
      async (req, reply) => {
        if (!req.isMultipart()) throw badRequest('Send multipart/form-data, or use /media/import for JSON');
        let profileId: string | undefined;
        let alt: string | undefined;
        let file: { data: Buffer; filename: string } | undefined;
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === 'file' && !file) file = { data: await part.toBuffer(), filename: part.filename };
            else part.file.resume();
          } else if (part.fieldname === 'profileId') profileId = String(part.value);
          else if (part.fieldname === 'alt') alt = String(part.value);
        }
        if (!profileId) throw badRequest('The profileId field is missing');
        if (!file) throw badRequest('The file field is missing');
        return reply.code(201).send(await addMedia(ctx, actorOf(req), { profileId, alt, ...file }));
      },
    );

    app.post(
      '/media/import',
      {
        preHandler: auth,
        bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 4096,
        schema: {
          tags: ['media'],
          security,
          summary: 'Add an image from a URL or from base64',
          description:
            'Give `url` (a public http(s) address BMM downloads) or `dataBase64`. Addresses inside private networks are refused.',
          body: ImportMediaRequestSchema,
          response: { 201: MediaSchema, ...errors },
        },
      },
      async (req, reply) => reply.code(201).send(await importMedia(ctx, actorOf(req), req.body)),
    );

    app.get(
      '/media',
      {
        preHandler: auth,
        schema: {
          tags: ['media'],
          security,
          summary: "List a profile's media, newest first",
          querystring: z.object({ profileId: z.string() }),
          response: { 200: z.object({ items: z.array(MediaSchema) }), ...errors },
        },
      },
      async (req) => ({ items: await listMedia(ctx, actorOf(req), req.query.profileId) }),
    );

    app.get(
      '/media/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['media'],
          security,
          summary: 'Get one media item',
          params: idParam,
          response: { 200: MediaSchema, ...errors },
        },
      },
      async (req) => getMedia(ctx, actorOf(req), req.params.id),
    );

    app.get(
      '/media/:id/content',
      {
        preHandler: auth,
        schema: { tags: ['media'], security, summary: 'Download the image itself', params: idParam },
      },
      async (req, reply) => {
        const { row, stream, bytes } = await mediaContent(ctx, actorOf(req), req.params.id);
        return reply
          .header('content-type', row.mime)
          .header('content-length', bytes)
          .header('cache-control', 'private, max-age=86400, immutable')
          .header('content-disposition', `inline; filename="${row.filename.replace(/"/g, '')}"`)
          .send(stream);
      },
    );

    app.delete(
      '/media/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['media'],
          security,
          summary: 'Delete an image',
          description: 'Refused while a post uses it.',
          params: idParam,
          response: { 204: z.null(), 409: ErrorSchema, ...errors },
        },
      },
      async (req, reply) => {
        await deleteMedia(ctx, actorOf(req), req.params.id);
        return reply.code(204).send(null);
      },
    );

    // -- Posts -------------------------------------------------------------

    app.post(
      '/posts/validate',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'Check a post without saving it',
          description:
            'Returns everything each chosen network would refuse (errors) and things worth knowing (warnings). Call this before scheduling; a post with errors cannot be scheduled or published.',
          body: ValidatePostRequestSchema,
          response: { 200: ValidationResultSchema, ...errors },
        },
      },
      async (req) => validatePost(ctx, actorOf(req), req.body),
    );

    app.post(
      '/posts',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'Create a post',
          description:
            '`action` decides what happens: `draft` saves it, `schedule` publishes at `scheduledAt`, `publish` publishes now. One post goes to one or more accounts of a profile; `targets[].text` overrides the text for that account.',
          body: CreatePostRequestSchema,
          response: { 201: PostSchema, 422: ErrorSchema, ...errors },
        },
      },
      async (req, reply) => reply.code(201).send(await createPost(ctx, actorOf(req), req.body)),
    );

    app.get(
      '/posts',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'List posts, newest first',
          querystring: ListPostsQuerySchema,
          response: { 200: PostPageSchema, ...errors },
        },
      },
      async (req) => listPosts(ctx, actorOf(req), req.query),
    );

    app.get(
      '/posts/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'Get a post with the outcome per account',
          description:
            'Each target carries its own status, the link to the published post, or the error the network gave.',
          params: idParam,
          response: { 200: PostSchema, ...errors },
        },
      },
      async (req) => getPost(ctx, actorOf(req), req.params.id),
    );

    app.patch(
      '/posts/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'Change, schedule or publish a post that has not gone out',
          description:
            'Works on drafts and scheduled posts. `action: "draft"` takes a scheduled post off the schedule.',
          params: idParam,
          body: UpdatePostRequestSchema,
          response: { 200: PostSchema, 409: ErrorSchema, 422: ErrorSchema, ...errors },
        },
      },
      async (req) => updatePost(ctx, actorOf(req), req.params.id, req.body),
    );

    app.post(
      '/posts/:id/retry',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'Try the failed accounts of a post again',
          description:
            'Accounts that already published are left alone. Read the error first: if it says the post may have been published, check the account before retrying.',
          params: idParam,
          response: { 200: PostSchema, 409: ErrorSchema, ...errors },
        },
      },
      async (req) => retryPost(ctx, actorOf(req), req.params.id),
    );

    app.delete(
      '/posts/:id',
      {
        preHandler: auth,
        schema: {
          tags: ['posts'],
          security,
          summary: 'Delete a post here',
          description: 'What was already published stays on the network.',
          params: idParam,
          response: { 204: z.null(), 409: ErrorSchema, ...errors },
        },
      },
      async (req, reply) => {
        await deletePost(ctx, actorOf(req), req.params.id);
        return reply.code(204).send(null);
      },
    );
  };
}
