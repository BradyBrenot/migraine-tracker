import { NavLink, Outlet } from 'react-router';
import { Home, CalendarDays, BarChart3, List, Settings } from 'lucide-react';
import { useStore } from '@/lib/store';
import RouteBoundary from '@/components/RouteBoundary';
import type { SyncStatus } from '../../shared/sync.ts';
import { Toaster } from '@/components/ui/sonner';

const tabs = [
  { to: '/', label: 'Log', icon: Home },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/history', label: 'History', icon: List },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const SYNC_PILL: Record<SyncStatus, { cls: string; label: string; dot: string }> = {
  synced: { cls: 'border-slate-800 text-slate-400', label: 'Synced', dot: 'bg-emerald-500' },
  syncing: { cls: 'border-sky-900 bg-sky-950/60 text-sky-300', label: 'Syncing…', dot: 'bg-sky-400 animate-pulse' },
  error: { cls: 'border-amber-900 bg-amber-950/60 text-amber-300', label: 'Unsynced', dot: 'bg-amber-400' },
  conflict: { cls: 'border-rose-900 bg-rose-950/60 text-rose-300', label: 'Needs review', dot: 'bg-rose-500' },
  // neutral wording + desktop-only so offline/demo users aren't alarmed
  local: { cls: 'border-slate-800 text-slate-400', label: 'Local only', dot: 'bg-slate-600' },
};

function SyncPill() {
  const { sync } = useStore();
  const s = SYNC_PILL[sync.status];
  const needsAttention =
    sync.status === 'error' || sync.status === 'conflict' || sync.status === 'syncing';
  return (
    <NavLink
      to="/settings"
      title={`Sync: ${s.label}`}
      className={`${s.cls} ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold lg:ml-3 ${
        needsAttention ? '' : 'hidden md:inline-flex'
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </NavLink>
  );
}

export default function Layout() {
  const { activeAttack } = useStore();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* First focusable element: keyboard users can jump the nav on every page. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950 focus:shadow-lg"
      >
        Skip to main content
      </a>
      {/* top bar */}
      <header className="sticky top-0 z-30 border-b bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl flex-nowrap items-center gap-2 px-4">
          <span className="min-w-0 truncate text-lg font-bold tracking-tight">
            🌀 Migraine Tracker
          </span>
          {activeAttack && (
            <span className="ml-1 flex shrink-0 items-center gap-1.5 rounded-full bg-rose-950 px-3 py-1 text-xs font-semibold text-rose-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-600" />
              </span>
              Attack in progress
            </span>
          )}
          <SyncPill />
          {/* desktop nav */}
          <nav aria-label="Primary" className="ml-auto hidden gap-1 lg:flex">
            {tabs.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-white text-slate-950'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-5xl scroll-mt-20 px-4 pb-[calc(6rem_+_env(safe-area-inset-bottom,0px))] pt-4 lg:pb-10 sm:pt-6"
      >
        <RouteBoundary>
          <Outlet />
        </RouteBoundary>
      </main>

      {/* mobile bottom nav */}
      <nav
        aria-label="Primary mobile"
        className="fixed bottom-0 left-0 right-0 z-30 border-t bg-slate-900/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
                  isActive ? 'text-slate-100' : 'text-slate-400'
                }`
              }
            >
              <Icon className="h-5 w-5" />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
      <Toaster position="top-center" theme="dark" richColors />
    </div>
  );
}
