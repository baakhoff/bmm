import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  busy?: boolean;
};

export function Button({ variant = 'primary', busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-brand text-brand-ink hover:opacity-90',
        variant === 'ghost' && 'border border-line bg-surface text-ink hover:bg-brand-soft',
        variant === 'danger' && 'border border-line bg-surface text-danger hover:bg-danger-soft',
        className,
      )}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = rest.id ?? rest.name;
  return (
    <div className="block">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-note` : undefined}
        className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted"
      />
      {(error || hint) && (
        <p id={`${id}-note`} className={cx('mt-1.5 text-xs', error ? 'text-danger' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'danger' | 'ok'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx(
        'rounded-md border px-3 py-2.5 text-sm',
        tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-line bg-brand-soft text-ink',
      )}
    >
      {children}
    </div>
  );
}

export function Card({
  title,
  description,
  children,
  action,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, lead, action }: { title: string; lead?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1 max-w-2xl text-sm text-muted">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--color-brand)" />
      <rect x="8" y="8" width="6" height="16" rx="2" fill="var(--color-brand-ink)" />
      <rect x="17" y="8" width="7" height="7" rx="2" fill="var(--color-brand-ink)" />
      <circle cx="20.5" cy="20.5" r="3.5" fill="var(--color-accent)" />
    </svg>
  );
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function relativeTime(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return iso;
}
