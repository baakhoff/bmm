import { type CreatedApiToken, SCOPE_DESCRIPTIONS, SCOPES, type Scope } from '@bmm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, Notice, PageHeader, relativeTime } from '../components/ui';

const EXPIRY = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Never', days: 0 },
];

export function TokensPage() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: api.revokeToken,
    onSuccess: () => {
      setConfirming(null);
      return qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });

  return (
    <>
      <PageHeader
        title="API tokens"
        lead="A token lets a script, an automation or an AI agent act as you. Give each one only the scopes it needs."
        action={
          !creating && (
            <Button
              onClick={() => {
                setCreating(true);
                setCreated(null);
              }}
            >
              New token
            </Button>
          )
        }
      />
      <div className="space-y-5">
        {created && <Secret token={created} onDone={() => setCreated(null)} />}
        {creating && (
          <CreateForm
            onCancel={() => setCreating(false)}
            onCreated={(t) => {
              setCreated(t);
              setCreating(false);
              qc.invalidateQueries({ queryKey: ['tokens'] });
            }}
          />
        )}
        {tokens.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tokens.isError ? (
          <Notice tone="danger">{tokens.error.message}</Notice>
        ) : tokens.data.items.length === 0 ? (
          !creating &&
          !created && (
            <div className="rounded-lg border border-line border-dashed px-6 py-10 text-center">
              <p className="font-medium">No tokens yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                Create one, then send it as <code className="font-mono text-[13px]">Authorization: Bearer …</code> with
                any API call.
              </p>
            </div>
          )
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {tokens.data.items.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <div className="font-medium">{t.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    <code className="font-mono">{t.prefix}…</code> · created {relativeTime(t.createdAt)} ·{' '}
                    {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : 'never used'} ·{' '}
                    {t.expiresAt ? `expires ${relativeTime(t.expiresAt)}` : 'no expiry'}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.scopes.map((s) => (
                      <span key={s} className="rounded bg-brand-soft px-1.5 py-0.5 font-mono text-[11px]">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
                {confirming === t.id ? (
                  <div className="flex items-center gap-2">
                    <Button variant="danger" busy={revoke.isPending} onClick={() => revoke.mutate(t.id)}>
                      Revoke for good
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirming(t.id)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && <Notice tone="danger">{revoke.error.message}</Notice>}
      </div>
    </>
  );
}

function Secret({ token, onDone }: { token: CreatedApiToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card
      title={`Token "${token.name}" created`}
      description="Copy it now. It is not stored and cannot be shown again."
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-paper px-3 py-2.5 font-mono text-sm">
          {token.token}
        </code>
        <Button variant="ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="mt-4 overflow-x-auto rounded-md border border-line bg-paper p-3 font-mono text-xs text-muted">
        {`curl -H "Authorization: Bearer ${token.token}" \\\n  ${window.location.origin}/api/v1/auth/me`}
      </pre>
      <div className="mt-4">
        <Button onClick={onDone}>I have saved it</Button>
      </div>
    </Card>
  );
}

function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (t: CreatedApiToken) => void }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [scopes, setScopes] = useState<Set<Scope>>(new Set());
  const isAdmin = scopes.has('admin');
  const create = useMutation({
    mutationFn: () =>
      api.createToken({ name, scopes: isAdmin ? ['admin'] : [...scopes], expiresInDays: days || undefined }),
    onSuccess: onCreated,
  });
  const toggle = (s: Scope) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Card title="New API token">
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field
            label="Name"
            name="token-name"
            required
            maxLength={100}
            placeholder="What will use it, e.g. Claude on my laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <div>
            <label htmlFor="token-expiry" className="mb-1.5 block text-sm font-medium">
              Expires after
            </label>
            <select
              id="token-expiry"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
            >
              {EXPIRY.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">What it may do</legend>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <label
                key={s}
                className={`flex items-start gap-2.5 text-sm ${isAdmin && s !== 'admin' ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-(--color-brand)"
                  checked={scopes.has(s) || (isAdmin && s !== 'admin')}
                  disabled={isAdmin && s !== 'admin'}
                  onChange={() => toggle(s)}
                />
                <span>
                  <code className="font-mono text-[13px]">{s}</code>
                  <span className="block text-xs text-muted">{SCOPE_DESCRIPTIONS[s]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {create.isError && <Notice tone="danger">{create.error.message}</Notice>}
        <div className="flex gap-2">
          <Button type="submit" busy={create.isPending} disabled={scopes.size === 0 || name.trim() === ''}>
            Create token
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
