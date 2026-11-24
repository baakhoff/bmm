import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe, useStatus, useVersion } from '../App';
import { api } from '../api';
import { Button, Card, Field, Notice, PageHeader, relativeTime } from '../components/ui';

export function SettingsPage() {
  const me = useMe();
  const status = useStatus();
  const version = useVersion();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const user = me.data?.user;
  const s = status.data;
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const mismatch = pw.confirm.length > 0 && pw.next !== pw.confirm;
  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: pw.current || undefined, newPassword: pw.next }),
    onSuccess: () => {
      setPw({ current: '', next: '', confirm: '' });
      return qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const unlink = useMutation({
    mutationFn: api.unlinkOidc,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) change.mutate();
  };
  if (!user || !s) return null;

  return (
    <>
      <PageHeader title="Settings" lead="How you sign in to this instance." />
      <div className="max-w-2xl space-y-5">
        <Card title="Account">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Username</dt>
            <dd>{user.username}</dd>
            <dt className="text-muted">Email</dt>
            <dd>{user.email ?? '—'}</dd>
            <dt className="text-muted">Role</dt>
            <dd>Admin</dd>
          </dl>
        </Card>

        <Card
          title="Single sign-on"
          description={
            s.oidc.enabled ? `This instance is connected to ${s.oidc.name}.` : 'Not configured on this instance.'
          }
        >
          {params.get('linked') && (
            <div className="mb-4">
              <Notice>Linked. You can now sign in with {s.oidc.name}.</Notice>
            </div>
          )}
          {params.get('error') && (
            <div className="mb-4">
              <Notice tone="danger">Linking did not finish. Start it again from this browser.</Notice>
            </div>
          )}
          {!s.oidc.enabled ? (
            <p className="text-sm text-muted">
              Set <code className="font-mono text-[13px]">BMM_OIDC_ISSUER</code>,{' '}
              <code className="font-mono text-[13px]">BMM_OIDC_CLIENT_ID</code> and{' '}
              <code className="font-mono text-[13px]">BMM_OIDC_CLIENT_SECRET</code> to sign in with Pocket ID,
              Authentik, Keycloak or any other OpenID Connect provider.
            </p>
          ) : user.oidcLinked ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Your account is linked to a {s.oidc.name} identity.</p>
              <Button
                variant="ghost"
                busy={unlink.isPending}
                disabled={!user.hasPassword || !s.passwordLoginEnabled}
                title={!user.hasPassword ? 'Set a password first, or you could not sign in' : undefined}
                onClick={() => unlink.mutate()}
              >
                Unlink
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-sm text-muted">
                Link your {s.oidc.name} identity to sign in without the password.
              </p>
              <a
                href="/api/v1/auth/oidc/link"
                className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-ink hover:opacity-90"
              >
                Connect {s.oidc.name} identity
              </a>
            </div>
          )}
          {unlink.isError && (
            <div className="mt-4">
              <Notice tone="danger">{unlink.error.message}</Notice>
            </div>
          )}
        </Card>

        {s.passwordLoginEnabled && (
          <Card
            title={user.hasPassword ? 'Change password' : 'Set a password'}
            description={
              user.hasPassword
                ? 'Changing it signs out your other sessions.'
                : 'A fallback for when the identity provider is unreachable.'
            }
          >
            <form onSubmit={submit} className="space-y-4">
              {/* Lets password managers attach the new password to the right account. */}
              <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
              {user.hasPassword && (
                <Field
                  label="Current password"
                  name="current"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={pw.current}
                  onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))}
                />
              )}
              <Field
                label="New password"
                name="next"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                hint="At least 10 characters."
                value={pw.next}
                onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
              />
              <Field
                label="Repeat new password"
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={pw.confirm}
                onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
                error={mismatch ? 'The two passwords differ.' : undefined}
              />
              {change.isError && <Notice tone="danger">{change.error.message}</Notice>}
              {change.isSuccess && <Notice>Password saved.</Notice>}
              <Button type="submit" busy={change.isPending}>
                Save password
              </Button>
            </form>
          </Card>
        )}
        <Card title="About this instance">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Version</dt>
            <dd>{s.version}</dd>
            <dt className="text-muted">Updates</dt>
            <dd>
              {!version.data
                ? '—'
                : !version.data.checkEnabled
                  ? 'Update check is turned off (BMM_UPDATE_CHECK=false).'
                  : version.data.updateAvailable
                    ? `Version ${version.data.latestVersion} is available.`
                    : version.data.updateAvailable === false
                      ? 'Up to date.'
                      : version.data.latestVersion
                        ? `This is a build from main. The latest release is ${version.data.latestVersion}.`
                        : 'Could not reach GitHub to check.'}
              {version.data?.checkedAt && (
                <span className="text-muted"> Checked {relativeTime(version.data.checkedAt)}.</span>
              )}
            </dd>
          </dl>
        </Card>
      </div>
    </>
  );
}
