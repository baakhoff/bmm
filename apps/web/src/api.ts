import type {
  ApiToken,
  AuditPage,
  AuthStatus,
  ChangePasswordRequest,
  CreateApiTokenRequest,
  CreatedApiToken,
  LoginRequest,
  Me,
  SetupRequest,
  SystemVersion,
  User,
} from '@bmm/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'error',
      data?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

export const api = {
  status: () => call<AuthStatus>('GET', '/auth/status'),
  me: () => call<Me>('GET', '/auth/me'),
  setup: (b: SetupRequest) => call<User>('POST', '/auth/setup', b),
  login: (b: LoginRequest) => call<User>('POST', '/auth/login', b),
  logout: () => call<void>('POST', '/auth/logout', {}),
  changePassword: (b: ChangePasswordRequest) => call<void>('POST', '/auth/password', b),
  unlinkOidc: () => call<void>('DELETE', '/auth/oidc/link'),
  tokens: () => call<{ items: ApiToken[] }>('GET', '/tokens'),
  createToken: (b: CreateApiTokenRequest) => call<CreatedApiToken>('POST', '/tokens', b),
  revokeToken: (id: string) => call<void>('DELETE', `/tokens/${id}`),
  version: () => call<SystemVersion>('GET', '/system/version'),
  audit: (before?: string) => call<AuditPage>('GET', `/audit?limit=50${before ? `&before=${before}` : ''}`),
};
