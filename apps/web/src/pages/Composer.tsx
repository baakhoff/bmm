import { type Account, NETWORK_LABELS, type Post, type ValidationIssue } from '@bmm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { Button, Card, Notice, PageHeader } from '../components/ui';

interface Draft {
  text: string;
  mediaIds: string[];
  /** accountId -> own text, or null to use the post's text. Absent: not targeted. */
  targets: Record<string, string | null>;
  when: string;
}

/** A Date as the value a datetime-local input wants, in the browser's zone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ComposerPage() {
  const { id = '', postId } = useParams();
  const existing = useQuery({
    queryKey: ['post', postId],
    queryFn: () => api.post(postId as string),
    enabled: Boolean(postId),
  });
  const accounts = useQuery({ queryKey: ['accounts', id], queryFn: () => api.accounts(id) });
  if (accounts.isPending || (postId && existing.isPending)) return <p className="text-sm text-muted">Loading…</p>;
  if (accounts.isError) return <Notice tone="danger">{accounts.error.message}</Notice>;
  if (postId && existing.isError) return <Notice tone="danger">{existing.error.message}</Notice>;
  if (existing.data && existing.data.status !== 'draft' && existing.data.status !== 'scheduled') {
    return (
      <Notice>
        This post is already {existing.data.status} and can no longer be changed.{' '}
        <Link className="underline" to={`/profiles/${id}`}>
          Back to the profile
        </Link>
      </Notice>
    );
  }
  return <Composer profileId={id} accounts={accounts.data.items} post={existing.data} />;
}

function Composer({ profileId, accounts, post }: { profileId: string; accounts: Account[]; post?: Post }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => ({
    text: post?.text ?? '',
    mediaIds: post?.media.map((m) => m.id) ?? [],
    targets: post
      ? Object.fromEntries(post.targets.map((t) => [t.accountId, t.text]))
      : Object.fromEntries(accounts.filter((a) => a.status === 'active').map((a) => [a.id, null])),
    when: post?.scheduledAt ? toLocalInput(new Date(post.scheduledAt)) : '',
  }));
  const library = useQuery({ queryKey: ['media', profileId], queryFn: () => api.media(profileId) });
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [alt, setAlt] = useState('');

  const content = useMemo(
    () => ({
      profileId,
      text: draft.text,
      mediaIds: draft.mediaIds,
      targets: Object.entries(draft.targets).map(([accountId, text]) => ({ accountId, text: text || null })),
    }),
    [profileId, draft.text, draft.mediaIds, draft.targets],
  );
  const settled = useDebounced(content, 400);
  const validation = useQuery({
    queryKey: ['validate', settled],
    queryFn: () => api.validatePost(settled),
    placeholderData: (prev) => prev,
  });
  const issues: ValidationIssue[] = validation.data?.issues ?? [];
  const blocked = issues.some((i) => i.level === 'error');

  const upload = useMutation({
    mutationFn: () => api.uploadMedia(profileId, pending as File, alt),
    onSuccess: (m) => {
      setDraft((d) => ({ ...d, mediaIds: [...d.mediaIds, m.id] }));
      setPending(null);
      setAlt('');
      if (fileInput.current) fileInput.current.value = '';
      return qc.invalidateQueries({ queryKey: ['media', profileId] });
    },
  });
  const save = useMutation({
    mutationFn: (action: 'draft' | 'schedule' | 'publish') => {
      const { profileId: _p, ...rest } = content;
      const body = {
        ...rest,
        action,
        scheduledAt: action === 'schedule' && draft.when ? new Date(draft.when).toISOString() : undefined,
      };
      return post ? api.updatePost(post.id, body) : api.createPost({ profileId, ...body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['posts', profileId] });
      qc.removeQueries({ queryKey: ['post'] });
      navigate(`/profiles/${profileId}`);
    },
  });

  const toggleMedia = (mid: string) =>
    setDraft((d) => ({
      ...d,
      mediaIds: d.mediaIds.includes(mid) ? d.mediaIds.filter((x) => x !== mid) : [...d.mediaIds, mid],
    }));
  const toggleAccount = (aid: string) =>
    setDraft((d) => {
      const targets = { ...d.targets };
      if (aid in targets) delete targets[aid];
      else targets[aid] = null;
      return { ...d, targets };
    });
  const setOwnText = (aid: string, text: string | null) =>
    setDraft((d) => ({ ...d, targets: { ...d.targets, [aid]: text } }));
  const issuesFor = (aid: string | null) => issues.filter((i) => i.accountId === aid);

  return (
    <>
      <PageHeader
        title={post ? 'Edit post' : 'New post'}
        lead="Write once, send to the accounts you choose. Each network's rules are checked as you type."
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <Card>
            <label htmlFor="post-text" className="mb-1.5 block text-sm font-medium">
              Text
            </label>
            <textarea
              id="post-text"
              rows={7}
              value={draft.text}
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              placeholder="What do you want to say?"
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            />
            <div className="mt-1 text-right text-xs text-muted tabular-nums">{[...draft.text].length} characters</div>
          </Card>

          <Card title="Images" description="Instagram needs at least one. X takes up to four.">
            {library.isError && <Notice tone="danger">{library.error.message}</Notice>}
            {(library.data?.items.length ?? 0) > 0 && (
              <ul className="mb-4 grid grid-cols-4 gap-2 sm:grid-cols-6">
                {library.data?.items.map((m) => {
                  const index = draft.mediaIds.indexOf(m.id);
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => toggleMedia(m.id)}
                        aria-pressed={index >= 0}
                        title={`${m.filename}, ${m.width}×${m.height}`}
                        className={`relative block aspect-square w-full overflow-hidden rounded-md border-2 ${index >= 0 ? 'border-brand' : 'border-transparent opacity-70 hover:opacity-100'}`}
                      >
                        <img
                          src={m.contentUrl}
                          alt={m.alt || m.filename}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                        {index >= 0 && (
                          <span className="absolute top-1 left-1 grid size-5 place-items-center rounded-full bg-brand text-[11px] font-semibold text-brand-ink">
                            {index + 1}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="post-file" className="mb-1.5 block text-sm font-medium">
                  Add an image
                </label>
                <input
                  id="post-file"
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => setPending(e.target.files?.[0] ?? null)}
                  className="block text-sm file:mr-3 file:h-10 file:rounded-md file:border file:border-line file:bg-surface file:px-4 file:text-sm file:font-medium"
                />
              </div>
              {pending && (
                <>
                  <div className="min-w-48 flex-1">
                    <label htmlFor="post-alt" className="mb-1.5 block text-sm font-medium">
                      Describe it for people who cannot see it
                    </label>
                    <input
                      id="post-alt"
                      value={alt}
                      maxLength={1000}
                      onChange={(e) => setAlt(e.target.value)}
                      className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
                    />
                  </div>
                  <Button busy={upload.isPending} onClick={() => upload.mutate()}>
                    Upload
                  </Button>
                </>
              )}
            </div>
            {upload.isError && (
              <div className="mt-3">
                <Notice tone="danger">{upload.error.message}</Notice>
              </div>
            )}
          </Card>

          <Card title="Send to">
            {accounts.length === 0 ? (
              <p className="text-sm text-muted">
                This profile has no connected accounts.{' '}
                <Link className="underline" to={`/profiles/${profileId}`}>
                  Connect one first.
                </Link>
              </p>
            ) : (
              <ul className="space-y-4">
                {accounts.map((a) => {
                  const on = a.id in draft.targets;
                  const own = draft.targets[a.id];
                  return (
                    <li key={a.id}>
                      <label className="flex items-center gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-(--color-brand)"
                          checked={on}
                          onChange={() => toggleAccount(a.id)}
                        />
                        <span className="font-medium">@{a.username}</span>
                        <span className="text-muted">on {NETWORK_LABELS[a.network]}</span>
                      </label>
                      {on && (
                        <div className="mt-2 ml-6 space-y-2">
                          {own === null || own === undefined ? (
                            <button
                              type="button"
                              className="text-xs text-brand underline-offset-4 hover:underline"
                              onClick={() => setOwnText(a.id, draft.text)}
                            >
                              Use different text for this account
                            </button>
                          ) : (
                            <div>
                              <label htmlFor={`own-${a.id}`} className="mb-1 block text-xs font-medium">
                                Text for @{a.username} only
                              </label>
                              <textarea
                                id={`own-${a.id}`}
                                rows={3}
                                value={own}
                                onChange={(e) => setOwnText(a.id, e.target.value)}
                                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
                              />
                              <button
                                type="button"
                                className="text-xs text-muted hover:text-ink"
                                onClick={() => setOwnText(a.id, null)}
                              >
                                Use the main text instead
                              </button>
                            </div>
                          )}
                          {issuesFor(a.id).map((i) => (
                            <p key={i.code} className={`text-xs ${i.level === 'error' ? 'text-danger' : 'text-muted'}`}>
                              {i.level === 'error' ? 'Cannot publish: ' : 'Note: '}
                              {i.message}
                            </p>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {issuesFor(null).map((i) => (
              <p key={i.code} className="mt-3 text-xs text-danger">
                {i.message}
              </p>
            ))}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="When">
            <label htmlFor="post-when" className="mb-1.5 block text-sm font-medium">
              Publish at
            </label>
            <input
              id="post-when"
              type="datetime-local"
              value={draft.when}
              min={toLocalInput(new Date())}
              onChange={(e) => setDraft((d) => ({ ...d, when: e.target.value }))}
              className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
            />
            <p className="mt-1.5 text-xs text-muted">
              In your own time zone, {Intl.DateTimeFormat().resolvedOptions().timeZone}.
            </p>
            <div className="mt-5 space-y-2">
              <Button
                className="w-full"
                disabled={blocked || !draft.when}
                busy={save.isPending && save.variables === 'schedule'}
                onClick={() => save.mutate('schedule')}
              >
                Schedule
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                disabled={blocked}
                busy={save.isPending && save.variables === 'publish'}
                onClick={() => {
                  const names = accounts
                    .filter((a) => a.id in draft.targets)
                    .map((a) => `@${a.username}`)
                    .join(', ');
                  if (window.confirm(`Publish now to ${names}? This is public and cannot be undone from BMM.`))
                    save.mutate('publish');
                }}
              >
                Publish now
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                busy={save.isPending && save.variables === 'draft'}
                onClick={() => save.mutate('draft')}
              >
                Save as draft
              </Button>
            </div>
            {blocked && (
              <p className="mt-3 text-xs text-danger">
                Fix what is marked "Cannot publish" to schedule or publish. A draft can be saved as it is.
              </p>
            )}
            {save.isError && (
              <div className="mt-3">
                <Notice tone="danger">{save.error.message}</Notice>
              </div>
            )}
          </Card>
          <Link to={`/profiles/${profileId}`} className="block text-center text-sm text-muted hover:text-ink">
            Cancel
          </Link>
        </div>
      </div>
    </>
  );
}
