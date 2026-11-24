import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useMe } from '../App';
import { api } from '../api';
import { Card, PageHeader, relativeTime } from '../components/ui';

export function OverviewPage() {
  const me = useMe();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens });
  const audit = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => api.audit() });
  const recent = audit.data?.items.slice(0, 6) ?? [];

  return (
    <>
      <PageHeader
        title={`Hello, ${me.data?.user.username}`}
        lead="This is the foundation release: sign-in, API tokens and the audit log. Profiles, accounts and scheduling build on it next."
      />
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
