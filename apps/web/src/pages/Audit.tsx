import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Button, Notice, PageHeader } from '../components/ui';

const ACTOR_LABEL = { user: 'Person', token: 'API token', system: 'System', anonymous: 'Not signed in' } as const;

export function AuditPage() {
  const q = useInfiniteQuery({
    queryKey: ['audit', 'all'],
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        lead="Every sign-in and every change, whether a person clicked it or an agent called it. Newest first."
      />
      {q.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : q.isError ? (
        <Notice tone="danger">{q.error.message}</Notice>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-line border-b text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Who</th>
                <th className="px-4 py-2.5 font-medium">Details</th>
                <th className="px-4 py-2.5 font-medium">From</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="border-line border-b align-top last:border-b-0">
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted tabular-nums">
                    <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                  </td>
                  <td className="px-4 py-2.5">
                    <code className={`font-mono text-[13px] ${e.action.includes('failed') ? 'text-danger' : ''}`}>
                      {e.action}
                    </code>
                  </td>
                  <td className="px-4 py-2.5">
                    {e.actorLabel ?? '—'}
                    <div className="text-xs text-muted">{ACTOR_LABEL[e.actorType]}</div>
                  </td>
                  <td className="max-w-xs px-4 py-2.5 text-muted">
                    {Object.keys(e.metadata).length > 0 && (
                      <code className="break-words font-mono text-xs">
                        {Object.entries(e.metadata)
                          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                          .join('  ')}
                      </code>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">{e.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="mt-4">
          <Button variant="ghost" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Load older entries
          </Button>
        </div>
      )}
    </>
  );
}
