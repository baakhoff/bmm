import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useStatus } from '../App';
import { api } from '../api';
import { Button, Field, Notice } from '../components/ui';
import { AuthFrame } from './AuthFrame';

const OIDC_ERRORS: Record<string, string> = {
  oidc_not_linked:
    'That identity is not linked to the admin account. Sign in with your password, then link it under Settings.',
  oidc_state: 'The sign-in attempt expired or was already used. Start again.',
  oidc_exchange: 'The identity provider rejected the sign-in. Check the client ID, secret and redirect address.',
  oidc_no_id_token: 'The identity provider did not return an identity. Check that the "openid" scope is allowed.',
  oidc_setup_token: 'This instance needs its setup token, so the first admin cannot be created through SSO.',
  oidc_disabled: 'SSO is not configured on this instance.',
};

export function LoginPage() {
  const status = useStatus();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ username: '', password: '' });
  const login = useMutation({ mutationFn: () => api.login(form), onSuccess: () => qc.invalidateQueries() });
  const oidcError = params.get('error');
  const s = status.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthFrame title="Sign in" lead="Your accounts, schedules and automations are behind this door.">
      <div className="space-y-4">
        {oidcError && !login.isError && (
          <Notice tone="danger">{OIDC_ERRORS[oidcError] ?? 'Sign-in failed. Try again.'}</Notice>
        )}
        {s?.oidc.enabled && (
          <a
            href="/api/v1/auth/oidc/start"
            className={`flex h-10 items-center justify-center rounded-md text-sm font-medium ${
              s.passwordLoginEnabled
                ? 'border border-line bg-surface hover:bg-brand-soft'
                : 'bg-brand text-brand-ink hover:opacity-90'
            }`}
          >
            Continue with {s.oidc.name}
          </a>
        )}
        {s?.oidc.enabled && s.passwordLoginEnabled && (
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {s?.passwordLoginEnabled && (
          <form onSubmit={submit} className="space-y-4">
            <Field
              label="Username"
              name="username"
              autoComplete="username"
              required
              autoFocus
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            {login.isError && <Notice tone="danger">{login.error.message}</Notice>}
            <Button type="submit" busy={login.isPending} className="w-full">
              Sign in
            </Button>
          </form>
        )}
      </div>
    </AuthFrame>
  );
}
