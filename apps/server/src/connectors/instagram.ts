import {
  type AccountInfo,
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

const SCOPES = 'instagram_business_basic,instagram_business_content_publish';
const DAY = 86_400_000;

function describe(body: Record<string, unknown>, status: number): { msg: string; err: Record<string, unknown> } {
  const err = (body.error && typeof body.error === 'object' ? body.error : body) as Record<string, unknown>;
  const text =
    (typeof err.error_user_msg === 'string' && err.error_user_msg) ||
    (typeof err.message === 'string' && err.message) ||
    (typeof err.error_message === 'string' && err.error_message) ||
    '';
  return { msg: text ? `Instagram answered ${status}: ${text}` : `Instagram answered ${status}`, err };
}

function fail(res: Response, body: Record<string, unknown>, finalCall = false): never {
  const { msg, err } = describe(body, res.status);
  const code = typeof err.code === 'number' ? err.code : 0;
  if (code === 190 || res.status === 401) throw new ConnectorError('reauth', `${msg}. Connect the account again.`);
  // 4, 17, 32, 613: rate limits. is_transient: Meta's own "try again".
  if ([4, 17, 32, 613].includes(code) || err.is_transient === true || res.status === 429 || res.status === 503) {
    throw new ConnectorError('retryable', msg);
  }
  if (res.status >= 500) throw new ConnectorError(finalCall ? 'unknown' : 'retryable', msg);
  throw new ConnectorError('permanent', msg);
}

export function instagramConnector(net: NetDeps): Connector {
  const graph = net.endpoints.instagramGraph;

  async function graphCall(
    path: string,
    accessToken: string,
    params?: Record<string, string>,
    opts: { method?: 'GET' | 'POST'; finalCall?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const method = opts.method ?? 'GET';
    const url = new URL(`${graph}${path}`);
    const init: RequestInit = { method, headers: { authorization: `Bearer ${accessToken}` } };
    if (method === 'GET') {
      for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    } else {
      init.headers = { ...init.headers, 'content-type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams(params ?? {});
    }
    const res = await send(net, url.toString(), init, opts.finalCall ? 'unknown' : 'retryable', 60_000);
    const body = await readJson(res);
    if (!res.ok) fail(res, body, opts.finalCall);
    return body;
  }

  async function me(accessToken: string): Promise<AccountInfo> {
    const b = await graphCall('/me', accessToken, { fields: 'user_id,username,name,profile_picture_url,account_type' });
    const id = b.user_id ?? b.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof b.username !== 'string') {
      throw new ConnectorError('permanent', 'Instagram did not say which account this is');
    }
    return {
      externalId: String(id),
      username: b.username,
      displayName: typeof b.name === 'string' ? b.name : null,
      avatarUrl: typeof b.profile_picture_url === 'string' ? b.profile_picture_url : null,
    };
  }

  function longLived(body: Record<string, unknown>): TokenSet {
    if (typeof body.access_token !== 'string')
      throw new ConnectorError('permanent', 'Instagram returned no access token');
    return {
      accessToken: body.access_token,
      refreshToken: null,
      expiresAt: typeof body.expires_in === 'number' ? new Date(net.now().getTime() + body.expires_in * 1000) : null,
      scopes: SCOPES,
    };
  }

  async function waitUntilReady(containerId: string, accessToken: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const b = await graphCall(`/${containerId}`, accessToken, { fields: 'status_code,status' });
      if (b.status_code === 'FINISHED') return;
      if (b.status_code === 'ERROR' || b.status_code === 'EXPIRED') {
        const why = typeof b.status === 'string' ? `: ${b.status}` : '';
        throw new ConnectorError(
          'permanent',
          `Instagram could not process the image${why}. Most often it could not download it: check that the public media address is reachable from the internet.`,
        );
      }
      await new Promise((r) => setTimeout(r, net.pollIntervalMs));
    }
    throw new ConnectorError('retryable', 'Instagram was still processing the image after a minute.');
  }

  return {
    network: 'instagram',

    authorizeUrl(app, redirectUri, state) {
      const u = new URL(net.endpoints.instagramAuthorize);
      u.search = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        state,
      }).toString();
      return u.toString();
    },

    async exchangeCode(app, redirectUri, code) {
      const res = await send(
        net,
        `${net.endpoints.instagramOauth}/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: app.clientId,
            client_secret: app.clientSecret,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            // Instagram appends "#_" to the code in the redirect; it is not part of it.
            code: code.replace(/#_$/, ''),
          }),
        },
        'retryable',
      );
      let body = await readJson(res);
      if (!res.ok) fail(res, body);
      if (Array.isArray(body.data) && body.data[0]) body = body.data[0] as Record<string, unknown>;
      if (typeof body.access_token !== 'string')
        throw new ConnectorError('permanent', 'Instagram returned no access token');
      // The first token lasts an hour. Trade it for the 60-day one straight away.
      const exchange = new URL(`${graph}/access_token`);
      exchange.search = new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: app.clientSecret,
        access_token: body.access_token,
      }).toString();
      const res2 = await send(net, exchange.toString(), {}, 'retryable');
      const body2 = await readJson(res2);
      if (!res2.ok) fail(res2, body2);
      const tokens = longLived(body2);
      return { tokens, account: await me(tokens.accessToken) };
    },

    needsRefresh(tokens, now) {
      // A 60-day token can be renewed once it is a day old. Renew weekly, and
      // always when within ten days of expiry.
      const age = now.getTime() - tokens.refreshedAt.getTime();
      if (age < DAY) return false;
      if (age > 7 * DAY) return true;
      return tokens.expiresAt !== null && tokens.expiresAt.getTime() - now.getTime() < 10 * DAY;
    },

    async refresh(_app, tokens) {
      const url = new URL(`${graph}/refresh_access_token`);
      url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: tokens.accessToken }).toString();
      const res = await send(net, url.toString(), {}, 'retryable');
      const body = await readJson(res);
      if (!res.ok) fail(res, body);
      return longLived(body);
    },

    validate(text, media: MediaFacts[], instance) {
      const out: Finding[] = [];
      if (media.length === 0) {
        out.push({
          level: 'error',
          code: 'instagram_needs_image',
          message: 'Instagram cannot publish text alone; add at least one image.',
        });
      }
      if (media.length > 10) {
        out.push({
          level: 'error',
          code: 'instagram_too_many_images',
          message: `Instagram takes at most 10 images; this post has ${media.length}.`,
        });
      }
      if ([...text].length > 2200) {
        out.push({
          level: 'error',
          code: 'instagram_caption_long',
          message: `The caption is ${[...text].length} characters; Instagram allows 2200.`,
        });
      }
      const tags = text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
      if (tags > 30) {
        out.push({
          level: 'error',
          code: 'instagram_hashtags',
          message: `Instagram allows 30 hashtags; this caption has ${tags}.`,
        });
      }
      for (const m of media) {
        const ratio = m.width / m.height;
        if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) {
          out.push({
            level: 'error',
            code: 'instagram_aspect_ratio',
            message: `"${m.filename}" is ${m.width}×${m.height}. Instagram takes images between 4:5 (portrait) and 1.91:1 (landscape); crop it first.`,
          });
        }
      }
      if (media.length > 0 && !instance.publicMedia) {
        out.push({
          level: 'error',
          code: 'instagram_public_media_missing',
          message:
            'Instagram downloads images from a public address, and this instance has none configured (BMM_PUBLIC_MEDIA_URL). See docs/public-media.md.',
        });
      }
      return out;
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      const t = input.accessToken;
      const user = input.account.externalId;
      const urls = input.media.map((m) => {
        if (!m.publicJpegUrl) {
          throw new ConnectorError(
            'permanent',
            'This instance has no public media address, so Instagram cannot download the image.',
          );
        }
        return m.publicJpegUrl;
      });
      let containerId: string;
      if (urls.length === 1) {
        const first = input.media[0];
        const b = await graphCall(
          `/${user}/media`,
          t,
          {
            image_url: urls[0] as string,
            caption: input.text,
            ...(first?.alt ? { alt_text: first.alt.slice(0, 1000) } : {}),
          },
          { method: 'POST' },
        );
        containerId = String(b.id);
      } else {
        const children: string[] = [];
        for (const [i, url] of urls.entries()) {
          const alt = input.media[i]?.alt;
          const b = await graphCall(
            `/${user}/media`,
            t,
            { image_url: url, is_carousel_item: 'true', ...(alt ? { alt_text: alt.slice(0, 1000) } : {}) },
            { method: 'POST' },
          );
          children.push(String(b.id));
        }
        for (const c of children) await waitUntilReady(c, t);
        const b = await graphCall(
          `/${user}/media`,
          t,
          { media_type: 'CAROUSEL', children: children.join(','), caption: input.text },
          { method: 'POST' },
        );
        containerId = String(b.id);
      }
      await waitUntilReady(containerId, t);
      const published = await graphCall(
        `/${user}/media_publish`,
        t,
        { creation_id: containerId },
        { method: 'POST', finalCall: true },
      );
      if (typeof published.id !== 'string' && typeof published.id !== 'number') {
        throw new ConnectorError(
          'unknown',
          'Instagram answered without a post id. It may have been published; check the account.',
        );
      }
      const id = String(published.id);
      // The link is nice to have; the post is already out.
      const link = await graphCall(`/${id}`, t, { fields: 'permalink' }).catch(() => ({}) as Record<string, unknown>);
      return { externalId: id, url: typeof link.permalink === 'string' ? link.permalink : null };
    },
  };
}
