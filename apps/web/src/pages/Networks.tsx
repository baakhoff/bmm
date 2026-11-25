import { NETWORK_LABELS, type Network, type NetworkApp } from '@bmm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, Notice, PageHeader } from '../components/ui';

const GUIDES: Record<Network, { href: string; idLabel: string; secretLabel: string; where: string }> = {
  x: {
    href: 'https://github.com/baakhoff/bmm/blob/main/docs/networks/x.md',
    idLabel: 'Client ID',
    secretLabel: 'Client Secret',
    where: 'X Developer Console, your app, Keys and tokens, OAuth 2.0',
  },
  instagram: {
    href: 'https://github.com/baakhoff/bmm/blob/main/docs/networks/instagram.md',
    idLabel: 'Instagram app ID',
    secretLabel: 'Instagram app secret',
    where: 'Meta for Developers, your app, Instagram, API setup with Instagram login',
  },
};

export function NetworksPage() {
  const status = useQuery({ queryKey: ['networks'], queryFn: api.networks });
  return (
    <>
      <PageHeader
        title="Networks"
        lead="BMM talks to each network through a developer app that you own. Set each one up once; every profile then connects its accounts through it."
      />
      {status.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : status.isError ? (
        <Notice tone="danger">{status.error.message}</Notice>
      ) : (
        <div className="max-w-3xl space-y-5">
          {status.data.apps.map((app) => (
            <AppCard key={app.network} app={app} />
          ))}
          <Card
            title="Public media address"
            description="Instagram does not accept uploads. It downloads each image from a public address at the moment of publishing."
          >
            {status.data.publicMediaUrl ? (
              <p className="text-sm">
                Configured: <code className="font-mono text-[13px]">{status.data.publicMediaUrl}</code>. Only signed
                links to single images, valid for two hours, are served there.
              </p>
            ) : (
              <Notice tone="danger">
                Not configured, so Instagram posts cannot be published yet. X is not affected. Set{' '}
                <code className="font-mono text-[13px]">BMM_PUBLIC_MEDIA_URL</code> to an address that reaches this
                instance&apos;s <code className="font-mono text-[13px]">/public/</code> path.{' '}
                <a
                  className="font-medium underline"
                  href="https://github.com/baakhoff/bmm/blob/main/docs/public-media.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  How to set it up
                </a>
              </Notice>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function AppCard({ app }: { app: NetworkApp }) {
  const qc = useQueryClient();
  const guide = GUIDES[app.network];
  const [editing, setEditing] = useState(!app.configured);
  const [form, setForm] = useState({ clientId: app.clientId ?? '', clientSecret: '' });
  const [copied, setCopied] = useState(false);
  const done = () => qc.invalidateQueries({ queryKey: ['networks'] });
  const save = useMutation({
    mutationFn: () => api.setNetworkApp(app.network, form),
    onSuccess: () => {
      setEditing(false);
      setForm((f) => ({ ...f, clientSecret: '' }));
      return done();
    },
  });
  const remove = useMutation({ mutationFn: () => api.removeNetworkApp(app.network), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card
      title={NETWORK_LABELS[app.network]}
      description={app.configured ? `Developer app configured (${app.clientId}).` : 'No developer app configured yet.'}
      action={
        <a
          href={guide.href}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-brand underline-offset-4 hover:underline"
        >
          Step-by-step guide ↗
        </a>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-sm font-medium">Redirect URI to register at {NETWORK_LABELS[app.network]}</div>
          {app.redirectUri ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px]">
                {app.redirectUri}
              </code>
              <Button
                variant="ghost"
                onClick={() =>
                  navigator.clipboard.writeText(app.redirectUri as string).then(
                    () => setCopied(true),
                    () => undefined,
                  )
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          ) : (
            <Notice tone="danger">
              Set <code className="font-mono text-[13px]">BMM_PUBLIC_URL</code> to the address you open BMM at. Accounts
              cannot be connected without it.
            </Notice>
          )}
        </div>
        {editing ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={guide.idLabel}
                name={`${app.network}-id`}
                required
                autoComplete="off"
                value={form.clientId}
                onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
              />
              <Field
                label={guide.secretLabel}
                name={`${app.network}-secret`}
                type="password"
                required
                autoComplete="off"
                value={form.clientSecret}
                onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
              />
            </div>
            <p className="text-xs text-muted">
              Found under: {guide.where}. The secret is stored encrypted and never shown again.
            </p>
            {save.isError && <Notice tone="danger">{save.error.message}</Notice>}
            <div className="flex gap-2">
              <Button type="submit" busy={save.isPending}>
                Save
              </Button>
              {app.configured && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Replace credentials
            </Button>
            <Button
              variant="danger"
              busy={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Remove the ${NETWORK_LABELS[app.network]} developer app? Connected accounts stop publishing until it is set again.`,
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              Remove
            </Button>
          </div>
        )}
        {remove.isError && <Notice tone="danger">{remove.error.message}</Notice>}
      </div>
    </Card>
  );
}
