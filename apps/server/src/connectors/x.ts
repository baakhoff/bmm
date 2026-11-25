import {
  type AccountInfo,
  type AppCreds,
  type Connector,
  ConnectorError,
  type Finding,
  type MediaFacts,
  type NetDeps,
  type PublishInput,
  type PublishResult,
  readJson,
  send,
  type TokenSet,
} from './types.js';

const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Length the way X counts it: a link is always 23, and characters outside
 * the Latin and general-punctuation ranges (CJK, emoji) count double.
 */
export function xWeightedLength(text: string): number {
  let n = 0;
  const withoutUrls = text.normalize('NFC').replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) as number;
    const single =
      cp <= 0x10ff ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    n += single ? 1 : 2;
  }
  return n;
}

function describe(body: Record<string, unknown>, status: number): string {
  const errs = Array.isArray(body.errors) ? (body.errors as Record<string, unknown>[]) : [];
  const first = errs[0];
  const detail =
    (typeof body.detail === 'string' && body.detail) ||
    (first && typeof first.message === 'string' && first.message) ||
    (first && typeof first.detail === 'string' && first.detail) ||
    (typeof body.error_description === 'string' && body.error_description) ||
    (typeof body.title === 'string' && body.title) ||
    (typeof body.error === 'string' && body.error) ||
    '';
  return detail ? `X answered ${status}: ${detail}` : `X answered ${status}`;
}

function fail(res: Response, body: Record<string, unknown>, finalCall = false): never {
  const msg = describe(body, res.status);
  if (res.status === 401) throw new ConnectorError('reauth', `${msg}. Connect the account again.`);
  if (res.status === 402) {
    throw new ConnectorError(
      'permanent',
      `${msg}. The X developer account is out of credits; add some in the X Developer Console.`,
    );
  }
  if (res.status === 429 || res.status === 503) throw new ConnectorError('retryable', msg);
  // Any other server error on the call that posts: X may have accepted it.
  if (res.status >= 500) throw new ConnectorError(finalCall ? 'unknown' : 'retryable', msg);
  throw new ConnectorError('permanent', msg);
}

export function xConnector(net: NetDeps): Connector {
  const api = net.endpoints.xApi;

  const basic = (app: AppCreds) => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`;

  async function token(app: AppCreds, params: Record<string, string>): Promise<TokenSet> {
    const res = await send(
      net,
      `${api}/2/oauth2/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(app) },
        body: new URLSearchParams({ ...params, client_id: app.clientId }),
      },
      'retryable',
    );
    const body = await readJson(res);
    if (!res.ok) {
      // A refused refresh token is not "try later": the grant is gone.
      if (res.status === 400 || res.status === 401) {
        throw new ConnectorError('reauth', `${describe(body, res.status)}. Connect the account again.`);
      }
      fail(res, body);
    }
    if (typeof body.access_token !== 'string') throw new ConnectorError('permanent', 'X returned no access token');
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: typeof body.expires_in === 'number' ? new Date(net.now().getTime() + body.expires_in * 1000) : null,
      scopes: typeof body.scope === 'string' ? body.scope : SCOPES,
    };
  }

  async function me(accessToken: string): Promise<AccountInfo> {
    const res = await send(
      net,
      `${api}/2/users/me?user.fields=profile_image_url,name,username`,
      { headers: { authorization: `Bearer ${accessToken}` } },
      'retryable',
    );
    const body = await readJson(res);
    if (!res.ok) fail(res, body);
    const d = (body.data ?? {}) as Record<string, unknown>;
    if (typeof d.id !== 'string' || typeof d.username !== 'string') {
      throw new ConnectorError('permanent', 'X did not say which account this is');
    }
    return {
      externalId: d.id,
      username: d.username,
      displayName: typeof d.name === 'string' ? d.name : null,
      avatarUrl: typeof d.profile_image_url === 'string' ? d.profile_image_url : null,
    };
  }

  return {
    network: 'x',

    authorizeUrl(app, redirectUri, state, codeChallenge) {
      const u = new URL(net.endpoints.xAuthorize);
      u.search = new URLSearchParams({
        response_type: 'code',
        client_id: app.clientId,
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return u.toString();
    },

    async exchangeCode(app, redirectUri, code, codeVerifier) {
      const tokens = await token(app, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      return { tokens, account: await me(tokens.accessToken) };
    },

    needsRefresh(tokens, now) {
      return tokens.expiresAt !== null && tokens.expiresAt.getTime() - now.getTime() < 5 * 60_000;
    },

    refresh(app, tokens) {
      if (!tokens.refreshToken) {
        throw new ConnectorError('reauth', 'X gave no refresh token for this account. Connect it again.');
      }
      return token(app, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    },

    validate(text, media: MediaFacts[]) {
      const out: Finding[] = [];
      const len = xWeightedLength(text);
      if (len === 0 && media.length === 0) {
        out.push({ level: 'error', code: 'x_empty', message: 'A post on X needs text or an image.' });
      }
      if (len > 280) {
        out.push({
          level: 'warning',
          code: 'x_long',
          message: `The text counts as ${len} on X. Over 280 only publishes from a Premium account.`,
        });
      }
      if (media.length > 4) {
        out.push({
          level: 'error',
          code: 'x_too_many_images',
          message: `X takes at most 4 images; this post has ${media.length}.`,
        });
      }
      for (const m of media) {
        if (m.bytes > MAX_IMAGE_BYTES) {
          out.push({
            level: 'error',
            code: 'x_image_too_large',
            message: `"${m.filename}" is ${(m.bytes / 1048576).toFixed(1)} MB; X takes images up to 5 MB.`,
          });
        }
      }
      if (URL_RE.test(text)) {
        out.push({
          level: 'warning',
          code: 'x_link_cost',
          message: 'X bills a post that contains a link at a higher rate than one without.',
        });
      }
      URL_RE.lastIndex = 0;
      return out;
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      const auth = { authorization: `Bearer ${input.accessToken}` };
      const mediaIds: string[] = [];
      for (const m of input.media) {
        const form = new FormData();
        form.set('media', new Blob([new Uint8Array(await m.load())], { type: m.mime }), m.filename);
        form.set('media_category', 'tweet_image');
        const res = await send(
          net,
          `${api}/2/media/upload`,
          { method: 'POST', headers: auth, body: form },
          'retryable',
          120_000,
        );
        const body = await readJson(res);
        if (!res.ok) fail(res, body);
        const id = ((body.data ?? {}) as Record<string, unknown>).id;
        if (typeof id !== 'string')
          throw new ConnectorError('permanent', 'X accepted the image but returned no id for it');
        mediaIds.push(id);
        if (m.alt) {
          // Alt text is worth having but not worth failing a post over.
          await send(
            net,
            `${api}/2/media/metadata`,
            {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({ id, metadata: { alt_text: { text: m.alt.slice(0, 1000) } } }),
            },
            'retryable',
          ).catch(() => undefined);
        }
      }
      const res = await send(
        net,
        `${api}/2/tweets`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ text: input.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }),
        },
        'unknown',
      );
      const body = await readJson(res);
      if (!res.ok) fail(res, body, true);
      const id = ((body.data ?? {}) as Record<string, unknown>).id;
      if (typeof id !== 'string') {
        throw new ConnectorError(
          'unknown',
          'X answered without a post id. It may have been published; check the account.',
        );
      }
      return { externalId: id, url: `https://x.com/${input.account.username}/status/${id}` };
    },
  };
}
