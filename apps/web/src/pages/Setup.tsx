import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useStatus } from '../App';
import { api } from '../api';
import { Button, Field, Notice } from '../components/ui';
import { AuthFrame } from './AuthFrame';

export function SetupPage() {
  const status = useStatus();
  const qc = useQueryClient();
  const [form, setForm] = useState({ username: '', password: '', confirm: '', setupToken: '' });
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const create = useMutation({
    mutationFn: () =>
      api.setup({ username: form.username, password: form.password, setupToken: form.setupToken || undefined }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) create.mutate();
  };
  const s = status.data;

  return (
    <AuthFrame
      title="Create the admin account"
      lead="This instance is new. The account you create here owns everything on it."
    >
      {s?.passwordLoginEnabled ? (
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Username"
            name="username"
            autoComplete="username"
            required
            minLength={2}
            value={form.username}
            onChange={set('username')}
            autoFocus
          />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            hint="At least 10 characters."
            value={form.password}
            onChange={set('password')}
          />
          <Field
            label="Repeat password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            onChange={set('confirm')}
            error={mismatch ? 'The two passwords differ.' : undefined}
          />
          {s.setupTokenRequired && (
            <Field
              label="Setup token"
              name="setupToken"
              required
              hint="The value of BMM_SETUP_TOKEN in this instance's configuration."
              value={form.setupToken}
              onChange={set('setupToken')}
            />
          )}
          {create.isError && <Notice tone="danger">{create.error.message}</Notice>}
          <Button type="submit" busy={create.isPending} className="w-full">
            Create account
          </Button>
        </form>
      ) : (
        <Notice>
          Password sign-in is off on this instance, so the first person to sign in with {s?.oidc.name} becomes the
          admin.
        </Notice>
      )}
      {s?.oidc.enabled && (
        <a
          href="/api/v1/auth/oidc/start"
          className="mt-4 flex h-10 items-center justify-center rounded-md border border-line bg-surface text-sm font-medium hover:bg-brand-soft"
        >
          Set up with {s.oidc.name} instead
        </a>
      )}
    </AuthFrame>
  );
}
