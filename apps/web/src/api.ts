import type {
  Account,
  ApiToken,
  AuditPage,
  AuthStatus,
  ChangePasswordRequest,
  CreateApiTokenRequest,
  CreatedApiToken,
  CreatePostRequest,
  CreateProfileRequest,
  LoginRequest,
  Me,
  Media,
  Network,
  NetworksStatus,
  Post,
  PostPage,
  Profile,
  SetupRequest,
  SystemVersion,
  UpdatePostRequest,
  UpdateProfileRequest,
  User,
  ValidatePostRequest,
  ValidationResult,
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

async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'error',
      data?.error?.message ?? `Upload failed (${res.status})`,
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
  profiles: () => call<{ items: Profile[] }>('GET', '/profiles'),
  profile: (id: string) => call<Profile>('GET', `/profiles/${id}`),
  createProfile: (b: CreateProfileRequest) => call<Profile>('POST', '/profiles', b),
  updateProfile: (id: string, b: UpdateProfileRequest) => call<Profile>('PATCH', `/profiles/${id}`, b),
  deleteProfile: (id: string) => call<void>('DELETE', `/profiles/${id}`),
  networks: () => call<NetworksStatus>('GET', '/networks'),
  setNetworkApp: (n: Network, b: { clientId: string; clientSecret: string }) =>
    call<void>('PUT', `/networks/${n}/app`, b),
  removeNetworkApp: (n: Network) => call<void>('DELETE', `/networks/${n}/app`),
  accounts: (profileId: string) => call<{ items: Account[] }>('GET', `/accounts?profileId=${profileId}`),
  disconnectAccount: (id: string) => call<void>('DELETE', `/accounts/${id}`),
  media: (profileId: string) => call<{ items: Media[] }>('GET', `/media?profileId=${profileId}`),
  uploadMedia: (profileId: string, file: File, alt: string) => {
    const form = new FormData();
    form.set('profileId', profileId);
    form.set('alt', alt);
    form.set('file', file);
    return upload<Media>('/media', form);
  },
  deleteMedia: (id: string) => call<void>('DELETE', `/media/${id}`),
  posts: (profileId: string, before?: string) =>
    call<PostPage>('GET', `/posts?profileId=${profileId}&limit=30${before ? `&before=${before}` : ''}`),
  post: (id: string) => call<Post>('GET', `/posts/${id}`),
  validatePost: (b: ValidatePostRequest) => call<ValidationResult>('POST', '/posts/validate', b),
  createPost: (b: CreatePostRequest) => call<Post>('POST', '/posts', b),
  updatePost: (id: string, b: UpdatePostRequest) => call<Post>('PATCH', `/posts/${id}`, b),
  retryPost: (id: string) => call<Post>('POST', `/posts/${id}/retry`, {}),
  deletePost: (id: string) => call<void>('DELETE', `/posts/${id}`),
  audit: (before?: string) => call<AuditPage>('GET', `/audit?limit=50${before ? `&before=${before}` : ''}`),
};
