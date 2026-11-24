import type { ReactNode } from 'react';
import { Mark } from '../components/ui';

export function AuthFrame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Mark className="size-9" />
          <div className="leading-tight">
            <div className="text-lg font-semibold tracking-tight">BMM</div>
            <div className="text-xs text-muted">Better Marketing Management</div>
          </div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 mb-6 text-sm text-muted">{lead}</p>
        {children}
      </div>
    </div>
  );
}
