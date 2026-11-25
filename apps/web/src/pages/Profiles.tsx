import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import { Button, Card, Field, Notice, PageHeader } from '../components/ui';

const zones: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function ProfilesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', timezone: localZone, color: '#1f5a41' });
  const create = useMutation({
    mutationFn: () => api.createProfile(form),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      navigate(`/profiles/${p.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const connectError = params.get('connect_error');

  return (
    <>
      <PageHeader
        title="Profiles"
        lead="A profile is one persona: its accounts, its images and its posts. Nothing is shared between profiles."
        action={!creating && <Button onClick={() => setCreating(true)}>New profile</Button>}
      />
      <div className="space-y-5">
        {connectError && <Notice tone="danger">Connecting did not finish: {connectError}</Notice>}
        {creating && (
          <Card title="New profile">
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_14rem_auto]">
                <Field
                  label="Name"
                  name="profile-name"
                  required
                  maxLength={80}
                  placeholder="Who is this? e.g. Studio, Personal"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
                <div>
                  <label htmlFor="profile-tz" className="mb-1.5 block text-sm font-medium">
                    Time zone
                  </label>
                  <select
                    id="profile-tz"
                    value={form.timezone}
                    onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                    className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
                  >
                    {zones.map((z) => (
                      <option key={z}>{z}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="profile-color" className="mb-1.5 block text-sm font-medium">
                    Colour
                  </label>
                  <input
                    id="profile-color"
                    type="color"
                    value={form.color}
                    onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                    className="h-10 w-16 rounded-md border border-line bg-surface p-1"
                  />
                </div>
              </div>
              {create.isError && <Notice tone="danger">{create.error.message}</Notice>}
              <div className="flex gap-2">
                <Button type="submit" busy={create.isPending} disabled={form.name.trim() === ''}>
                  Create profile
                </Button>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}
        {profiles.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : profiles.isError ? (
          <Notice tone="danger">{profiles.error.message}</Notice>
        ) : profiles.data.items.length === 0 ? (
          !creating && (
            <div className="rounded-lg border border-line border-dashed px-6 py-10 text-center">
              <p className="font-medium">No profiles yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                Create one for each persona you post as, then connect its X and Instagram accounts.
              </p>
            </div>
          )
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {profiles.data.items.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/profiles/${p.id}`}
                  className="flex items-center gap-4 rounded-lg border border-line bg-surface px-5 py-4 hover:border-brand"
                >
                  <span
                    className="grid size-11 shrink-0 place-items-center rounded-full text-base font-semibold text-white"
                    style={{ background: p.color }}
                    aria-hidden="true"
                  >
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block text-xs text-muted">
                      {p.accountCount === 0
                        ? 'No accounts connected'
                        : `${p.accountCount} account${p.accountCount === 1 ? '' : 's'}`}{' '}
                      · {p.timezone}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
