import type { Network } from '@bmm/shared';

export interface AppCreds {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string;
}

export interface AccountInfo {
  externalId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface MediaFacts {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  alt: string;
  filename: string;
}

export interface PublishMedia extends MediaFacts {
  load(): Promise<Buffer>;
  /** A signed public address serving this image as JPEG, if the instance has a public edge. */
  publicJpegUrl: string | null;
}

export interface PublishInput {
  accessToken: string;
  account: { externalId: string; username: string };
  text: string;
  media: PublishMedia[];
}

export interface PublishResult {
  externalId: string;
  url: string | null;
}

export interface Finding {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

/**
 * How a call to a network failed, which decides what happens next.
 *
 * retryable  the network said "not now" before anything was posted
 * permanent  it said no; trying again would get the same answer
 * reauth     our access is gone; the person has to connect the account again
 * unknown    the request that posts was sent and no answer came back, so the
 *            post may exist. Never retried: a duplicate is worse than a gap.
 */
export class ConnectorError extends Error {
  constructor(
    public readonly kind: 'retryable' | 'permanent' | 'reauth' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

export interface NetDeps {
  fetch: typeof fetch;
  /** Overridden in tests to point at stand-in servers. */
  endpoints: {
    xApi: string;
    xAuthorize: string;
    instagramAuthorize: string;
    instagramOauth: string;
    instagramGraph: string;
  };
  /** Shortened in tests. */
  pollIntervalMs: number;
  /** The clock token lifetimes are measured against. */
  now: () => Date;
}

export const DEFAULT_ENDPOINTS: NetDeps['endpoints'] = {
  xApi: 'https://api.x.com',
  xAuthorize: 'https://x.com/i/oauth2/authorize',
  instagramAuthorize: 'https://www.instagram.com/oauth/authorize',
  instagramOauth: 'https://api.instagram.com',
  instagramGraph: 'https://graph.instagram.com',
};

export interface Connector {
  network: Network;
  /** Where the browser goes to approve the connection. */
  authorizeUrl(app: AppCreds, redirectUri: string, state: string, codeChallenge: string): string;
  exchangeCode(
    app: AppCreds,
    redirectUri: string,
    code: string,
    codeVerifier: string,
  ): Promise<{ tokens: TokenSet; account: AccountInfo }>;
  /** Whether the token should be renewed before the next call. */
  needsRefresh(tokens: { expiresAt: Date | null; refreshedAt: Date }, now: Date): boolean;
  refresh(app: AppCreds, tokens: { accessToken: string; refreshToken: string | null }): Promise<TokenSet>;
  /** Everything that can be known to be wrong without calling the network. */
  validate(text: string, media: MediaFacts[], instance: { publicMedia: boolean }): Finding[];
  publish(input: PublishInput): Promise<PublishResult>;
}

/** fetch that turns "no answer" into a ConnectorError of the given kind. */
export async function send(
  net: NetDeps,
  url: string,
  init: RequestInit,
  onNoAnswer: 'retryable' | 'unknown',
  timeoutMs = 30_000,
): Promise<Response> {
  try {
    return await net.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new ConnectorError(
      onNoAnswer,
      onNoAnswer === 'unknown'
        ? `No answer from the network after sending the post (${why}). It may or may not have been published; check the account before retrying.`
        : `Could not reach the network (${why}).`,
    );
  }
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}
