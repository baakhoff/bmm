import { NETWORK_LABELS, NETWORKS, type Post } from '@bmm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import { Button, Card, Notice, PageHeader, relativeTime } from '../components/ui';

const STATUS: Record<Post['status'], { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-paper text-muted border border-line' },
  scheduled: { label: 'Scheduled', tone: 'bg-brand-soft text-ink' },
  publishing: { label: 'Publishing', tone: 'bg-brand-soft text-ink' },
  published: { label: 'Published', tone: 'bg-brand text-brand-ink' },
  partial: { label: 'Partly published', tone: 'bg-danger-soft text-danger' },
  failed: { label: 'Failed', tone: 'bg-danger-soft text-danger' },
};

export function ProfilePage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const profile = useQuery({ queryKey: ['profile', id], queryFn: () => api.profile(id) });
  const accounts = useQuery({ queryKey: ['accounts', id], queryFn: () => api.accounts(id) });
  const networks = useQuery({ queryKey: ['networks'], queryFn: api.networks });
  const posts = useQuery({
    queryKey: ['posts', id],
    queryFn: () => api.posts(id),
    // While something is on its way out, keep looking.
    refetchInterval: (q) =>
      q.state.data?.items.some((p) => p.status === 'publishing' || p.status === 'scheduled') ? 5000 : false,
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectAccount,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts', id] });
      qc.invalidateQueries({ queryKey: ['posts', id] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProfile(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      navigate('/profiles');
    },
  });

  if (profile.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (profile.isError) return <Notice tone="danger">{profile.error.message}</Notice>;
  const p = profile.data;
  const configured = new Set(networks.data?.apps.filter((a) => a.configured).map((a) => a.network));
  const hasAccounts = (accounts.data?.items.length ?? 0) > 0;

  return (
    <>
      <PageHeader
        title={p.name}
        lead={`Times for this profile are in ${p.timezone}.`}
        action={
          hasAccounts && (
            <Link
              to={`/profiles/${id}/compose`}
              className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-ink hover:opacity-90"
            >
              New post
            </Link>
          )
        }
      />
      <div className="space-y-5">
        {params.get('connected') && <Notice>Connected {params.get('connected')}.</Notice>}
        {params.get('connect_error') && (
          <Notice tone="danger">Connecting did not finish: {params.get('connect_error')}</Notice>
        )}

        <Card title="Accounts" description="The accounts this persona posts from.">
          {accounts.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : accounts.isError ? (
            <Notice tone="danger">{accounts.error.message}</Notice>
          ) : (
            <>
              {accounts.data.items.length > 0 && (
                <ul className="mb-4 divide-y divide-line">
                  {accounts.data.items.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                      <div className="flex min-w-0 items-center gap-3">
                        {a.avatarUrl ? (
                          <img
                            src={a.avatarUrl}
                            alt=""
                            className="size-9 rounded-full bg-brand-soft"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.visibility = 'hidden';
                            }}
                          />
                        ) : (
                          <span
                            className="grid size-9 place-items-center rounded-full bg-brand-soft text-sm font-semibold"
                            aria-hidden="true"
                          >
                            {a.username.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            @{a.username} <span className="font-normal text-muted">on {NETWORK_LABELS[a.network]}</span>
                          </div>
                          {a.status === 'needs_reauth' ? (
                            <div className="text-xs text-danger">Access was revoked or expired. Connect it again.</div>
                          ) : (
                            <div className="text-xs text-muted">Connected {relativeTime(a.connectedAt)}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {a.status === 'needs_reauth' && (
                          <a
                            href={`/api/v1/profiles/${id}/connect/${a.network}`}
                            className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-ink hover:opacity-90"
                          >
                            Reconnect
                          </a>
                        )}
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Disconnect @${a.username}? Its scheduled posts will no longer go to this account.`,
                              )
                            ) {
                              disconnect.mutate(a.id);
                            }
                          }}
                        >
                          Disconnect
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {NETWORKS.map((n) =>
                  configured.has(n) ? (
                    <a
                      key={n}
                      href={`/api/v1/profiles/${id}/connect/${n}`}
                      className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-4 text-sm font-medium hover:bg-brand-soft"
                    >
                      Connect {NETWORK_LABELS[n]} account
                    </a>
                  ) : (
                    <Link
                      key={n}
                      to="/networks"
                      className="inline-flex h-10 items-center rounded-md border border-line border-dashed px-4 text-sm text-muted hover:text-ink"
                    >
                      Set up {NETWORK_LABELS[n]} first
                    </Link>
                  ),
                )}
              </div>
              {disconnect.isError && (
                <div className="mt-4">
                  <Notice tone="danger">{disconnect.error.message}</Notice>
                </div>
              )}
            </>
          )}
        </Card>

        <section>
          <h2 className="mb-3 text-base font-semibold">Posts</h2>
          {posts.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : posts.isError ? (
            <Notice tone="danger">{posts.error.message}</Notice>
          ) : posts.data.items.length === 0 ? (
            <div className="rounded-lg border border-line border-dashed px-6 py-10 text-center">
              <p className="font-medium">Nothing here yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                {hasAccounts
                  ? 'Write the first post for this profile.'
                  : 'Connect an account above, then write the first post.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {posts.data.items.map((post) => (
                <PostCard key={post.id} post={post} profileId={id} />
              ))}
            </ul>
          )}
        </section>

        <div className="border-line border-t pt-5">
          <Button
            variant="danger"
            busy={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete the profile "${p.name}" with its accounts, images and posts? Scheduled posts will not go out. This cannot be undone.`,
                )
              ) {
                remove.mutate();
              }
            }}
          >
            Delete this profile
          </Button>
          {remove.isError && (
            <div className="mt-3">
              <Notice tone="danger">{remove.error.message}</Notice>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function PostCard({ post, profileId }: { post: Post; profileId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['posts', profileId] });
  const retry = useMutation({ mutationFn: () => api.retryPost(post.id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.deletePost(post.id), onSuccess: refresh });
  const s = STATUS[post.status];
  const editable = post.status === 'draft' || post.status === 'scheduled';
  const error = retry.error ?? remove.error;

  return (
    <li className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-2 py-0.5 font-medium ${s.tone}`}>{s.label}</span>
          {post.scheduledAt && (post.status === 'scheduled' || post.status === 'draft') && (
            <time dateTime={post.scheduledAt} className="text-muted">
              for {new Date(post.scheduledAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </time>
          )}
          <span className="text-muted">
            created {relativeTime(post.createdAt)}
            {post.createdBy ? ` by ${post.createdBy}` : ''}
          </span>
        </div>
        <div className="flex gap-2">
          {editable && (
            <Link
              to={`/profiles/${profileId}/posts/${post.id}`}
              className="inline-flex h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-brand-soft"
            >
              Edit
            </Link>
          )}
          {(post.status === 'failed' || post.status === 'partial') && (
            <Button variant="ghost" className="h-9 px-3" busy={retry.isPending} onClick={() => retry.mutate()}>
              Retry failed
            </Button>
          )}
          {post.status !== 'publishing' && (
            <Button
              variant="ghost"
              className="h-9 px-3"
              busy={remove.isPending}
              onClick={() => {
                const note =
                  post.status === 'published' || post.status === 'partial'
                    ? ' What is already published stays on the network.'
                    : '';
                if (window.confirm(`Delete this post from BMM?${note}`)) remove.mutate();
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-4">
        {post.media.length > 0 && (
          <div className="flex shrink-0 gap-1.5">
            {post.media.slice(0, 3).map((m) => (
              <img
                key={m.id}
                src={m.contentUrl}
                alt={m.alt}
                className="size-16 rounded-md border border-line object-cover"
                loading="lazy"
              />
            ))}
            {post.media.length > 3 && (
              <span className="grid size-16 place-items-center rounded-md border border-line text-xs text-muted">
                +{post.media.length - 3}
              </span>
            )}
          </div>
        )}
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm">
          {post.text || <span className="text-muted">No text</span>}
        </p>
      </div>
      {post.targets.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-line border-t pt-3 text-sm">
          {post.targets.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">
                @{t.username} <span className="font-normal text-muted">on {NETWORK_LABELS[t.network]}</span>
              </span>
              {t.status === 'published' && t.externalUrl ? (
                <a
                  href={t.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand underline-offset-4 hover:underline"
                >
                  View post ↗
                </a>
              ) : t.status === 'published' ? (
                <span className="text-muted">published</span>
              ) : t.status === 'failed' ? (
                <span className="text-danger">{t.error}</span>
              ) : t.status === 'retrying' ? (
                <span className="text-muted">will try again shortly ({t.error})</span>
              ) : t.status === 'publishing' ? (
                <span className="text-muted">publishing…</span>
              ) : null}
              {t.text && <span className="text-xs text-muted">own text</span>}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="danger">{error.message}</Notice>
        </div>
      )}
    </li>
  );
}
