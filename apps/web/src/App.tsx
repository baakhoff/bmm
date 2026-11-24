import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { ApiError, api } from './api';
import { Button, Mark, Notice } from './components/ui';
import { AuditPage } from './pages/Audit';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { SetupPage } from './pages/Setup';
import { TokensPage } from './pages/Tokens';

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: api.status });
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

export function useVersion() {
  return useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 30 * 60_000, retry: false });
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-6 text-sm text-muted">{children}</div>;
}

export function App() {
  const status = useStatus();
  const me = useMe();
  const location = useLocation();

  if (status.isPending || me.isPending) return <FullScreen>Loading…</FullScreen>;
  if (status.isError || me.isError) {
    return (
      <FullScreen>
        <div className="w-full max-w-sm space-y-3">
          <Notice tone="danger">{(status.error ?? me.error)?.message}</Notice>
          <Button
            variant="ghost"
            onClick={() => {
              status.refetch();
              me.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </FullScreen>
    );
  }

  const signedIn = me.data !== null;
  if (status.data.setupRequired && location.pathname !== '/setup') return <Navigate to="/setup" replace />;

  return (
    <Routes>
      <Route path="/setup" element={status.data.setupRequired ? <SetupPage /> : <Navigate to="/" replace />} />
      <Route path="/login" element={signedIn ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={signedIn ? <Shell /> : <Navigate to="/login" replace />}>
        <Route index element={<OverviewPage />} />
        <Route path="tokens" element={<TokensPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/tokens', label: 'API tokens' },
  { to: '/audit', label: 'Audit log' },
  { to: '/settings', label: 'Settings' },
];

function Shell() {
  const me = useMe();
  const status = useStatus();
  const version = useVersion();
  const qc = useQueryClient();
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    qc.clear();
    window.location.assign('/login');
  };
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-line border-b px-4 py-4 md:w-56 md:border-r md:border-b-0 md:py-6">
        <div className="flex items-center gap-2.5 px-2">
          <Mark className="size-7" />
          <div className="leading-tight">
            <div className="font-semibold tracking-tight">BMM</div>
            <div className="text-[11px] text-muted">Better Marketing Management</div>
          </div>
        </div>
        <nav className="mt-4 flex gap-1 overflow-x-auto md:mt-8 md:flex-col" aria-label="Main">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand-soft font-medium text-ink' : 'text-muted hover:text-ink'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
          <a href="/api/docs" className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-muted hover:text-ink">
            API reference ↗
          </a>
        </nav>
        <div className="mt-4 hidden border-line border-t pt-4 md:mt-auto md:block">
          <div className="px-2 text-sm font-medium">{me.data?.user.username}</div>
          <div className="px-2 text-xs text-muted">v{status.data?.version}</div>
          <button
            type="button"
            onClick={signOut}
            className="mt-2 rounded-md px-2 py-1.5 text-sm text-muted hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-10">
        {version.data?.updateAvailable && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-line bg-brand-soft px-4 py-2.5 text-sm">
            <span>
              <strong className="font-semibold">BMM {version.data.latestVersion} is available.</strong> This instance
              runs {version.data.version}.
            </span>
            {version.data.releaseUrl && (
              <a
                href={version.data.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand underline-offset-4 hover:underline"
              >
                See what changed ↗
              </a>
            )}
          </div>
        )}
        <Outlet />
        <div className="mt-10 border-line border-t pt-4 md:hidden">
          <button type="button" onClick={signOut} className="text-sm text-muted hover:text-ink">
            Sign out {me.data?.user.username}
          </button>
        </div>
      </main>
    </div>
  );
}
