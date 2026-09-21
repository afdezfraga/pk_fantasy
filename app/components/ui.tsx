/** Shared presentational pieces. Server components — no client JS unless a page needs it. */

import Link from 'next/link';

import type { Tier } from '../../config/economy.ts';
import { TIER_CLASS, typeColor } from '../../lib/format.ts';

export function TierBadge({ tier, className = '' }: { tier: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[11px] font-bold leading-none ${
        TIER_CLASS[tier as Tier] ?? TIER_CLASS.UR
      } ${className}`}
    >
      {tier}
    </span>
  );
}

export function TypePills({ types }: { types: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {types.map((type) => (
        <span
          key={type}
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/95"
          style={{ backgroundColor: typeColor(type) }}
        >
          {type}
        </span>
      ))}
    </span>
  );
}

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const toneClass = tone === 'good' ? 'text-positive' : tone === 'bad' ? 'text-negative' : 'text-ink';
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`tabular text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const variants = {
    primary: 'bg-accent text-accent-ink hover:brightness-110',
    ghost: 'border border-line bg-panel-2 text-ink hover:bg-line',
    danger: 'border border-negative/40 bg-negative/10 text-negative hover:bg-negative/20',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent/60';

export function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
      {children}
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export type NavKey = 'home' | 'market' | 'squad' | 'draft' | 'matches' | 'trades';

export function NavTabs({
  leagueId,
  active,
  showDraft = false,
}: {
  leagueId: string;
  active: NavKey;
  /** The draft tab only earns its place while there is a draft to look at. */
  showDraft?: boolean;
}) {
  const tabs = [
    { key: 'home', href: `/league/${leagueId}`, label: 'League' },
    { key: 'squad', href: `/league/${leagueId}/squad`, label: 'Club' },
    { key: 'market', href: `/league/${leagueId}/market`, label: 'Market' },
    { key: 'matches', href: `/league/${leagueId}/matches`, label: 'Matches' },
    { key: 'trades', href: `/league/${leagueId}/trades`, label: 'Trades' },
    ...(showDraft || active === 'draft'
      ? [{ key: 'draft' as const, href: `/league/${leagueId}/draft`, label: 'Draft' }]
      : []),
  ] as const;

  return (
    <nav className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition ${
            active === tab.key ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-panel-2 hover:text-ink'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
