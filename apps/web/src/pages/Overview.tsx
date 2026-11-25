import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useMe } from '../App';
import { api } from '../api';
import { Card, PageHeader, relativeTime } from '../components/ui';

export function OverviewPage() {
  const me = useMe();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const audit = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => api.audit() });
  const recent = audit.data?.items.slice(0, 6) ?? [];

  return (
    <>
      <PageHeader
        title={`Hello, ${me.data?.user.username}`}
        lead="Create a profile for each persona, connect its accounts, and schedule posts by hand, through the API or with an AI agent over MCP."
      />
      <div className="mb-5">
        <Card
          title="Profiles"
          action={
            <Link to="/profiles" className="text-sm font-medium text-brand underline-offset-4 hover:underline">
              All profiles
            </Link>
          }
        >
          {profiles.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : profiles.isError ? (
            <p className="text-sm text-danger">{profiles.error.message}</p>
          ) : profiles.data.items.length === 0 ? (
            <p className="text-sm text-muted">
              No profiles yet.{' '}
              <Link to="/profiles" className="font-medium text-brand underline-offset-4 hover:underline">
                Create the first one
              </Link>{' '}
              and connect its accounts. Set up the networks under{' '}
              <Link to="/networks" className="font-medium text-brand underline-offset-4 hover:underline">
                Networks
              </Link>{' '}
              first.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {profiles.data.items.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/profiles/${p.id}`}
                    className="flex items-center gap-2 rounded-full border border-line py-1 pr-3 pl-1 text-sm hover:border-brand"
                  >
                    <span
                      className="grid size-6 place-items-center rounded-full text-xs font-semibold text-white"
                      style={{ background: p.color }}
                      aria-hidden="true"
                    >
                      {p.name.slice(0, 1).toUpperCase()}
                    </span>
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Automate it" description="Everything here is also an API.">
          <p className="text-sm text-muted">
            {tokens.data
              ? tokens.data.items.length === 0
                ? 'No API tokens yet. Create one to drive BMM from a script or an AI agent.'
                : `${tokens.data.items.length} active API token${tokens.data.items.length === 1 ? '' : 's'}.`
              : 'Loading…'}
          </p>
          <div className="mt-4 flex flex-wrap gap-4 text-sm font-medium">
            <Link to="/tokens" className="text-brand underline-offset-4 hover:underline">
              Manage API tokens
            </Link>
            <a href="/api/docs" className="text-brand underline-offset-4 hover:underline">
              Open the API reference
            </a>
          </div>
        </Card>
        <Card
          title="Recent activity"
          action={
            <Link to="/audit" className="text-sm font-medium text-brand underline-offset-4 hover:underline">
              Full log
            </Link>
          }
        >
          {audit.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : audit.isError ? (
            <p className="text-sm text-danger">{audit.error.message}</p>
          ) : (
            <ul className="space-y-2.5">
              {recent.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <code className="font-mono text-[13px]">{e.action}</code>
                    <span className="text-muted"> by {e.actorLabel ?? e.actorType}</span>
                  </span>
                  <time dateTime={e.at} className="shrink-0 text-xs text-muted">
                    {relativeTime(e.at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
