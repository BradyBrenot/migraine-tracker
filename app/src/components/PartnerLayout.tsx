import { NavLink, Outlet } from 'react-router';
import { BarChart3, CalendarDays, Home, List, Lock } from 'lucide-react';
import { useStore } from '@/lib/store';
import type { SyncStatus } from '../../shared/sync.ts';

const tabs = [
  { to: '/view', label: 'Now', icon: Home },
  { to: '/view/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/view/reports', label: 'Reports', icon: BarChart3 },
  { to: '/view/history', label: 'History', icon: List },
] as const;

interface ViewerStatus {
  label: string;
  cls: string;
  dot: string;
  title: string;
}

function viewerStatus(serverMode: boolean, status: SyncStatus): ViewerStatus {
  if (status === 'synced') {
    return {
      label: 'Live',
      cls: 'border-slate-800 text-slate-400',
      dot: 'bg-emerald-500',
      title: 'Showing the latest server data',
    };
  }
  if (status === 'error') {
    return serverMode
      ? {
        label: 'Stale',
        cls: 'border-amber-900 bg-amber-950/60 text-amber-300',
        dot: 'bg-amber-400',
        title: 'The server is unreachable — showing the last successful update',
      }
      : {
        label: 'Unavailable',
        cls: 'border-rose-900 bg-rose-950/60 text-rose-300',
        dot: 'bg-rose-500',
        title: 'The server is unreachable — retrying automatically',
      };
  }
  return {
    label: 'Updating',
    cls: 'border-sky-900 bg-sky-950/60 text-sky-300',
    dot: 'bg-sky-400 animate-pulse',
    title: 'Loading the latest server data',
  };
}

function StatusPill() {
  const { serverMode, sync } = useStore();
  const s = viewerStatus(serverMode, sync.status);
  return (
    <span
      title={s.title}
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/**
 * Partner viewer shell: navigation and freshness only. It intentionally has no
 * Settings link, no link back to the writer app, and no Toaster/mutation UI.
 */
export default function PartnerLayout() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-30 border-b bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-nowrap items-center gap-2 px-4 py-2">
          <span className="min-w-0 truncate text-lg font-bold tracking-tight">🌀 Migraine Tracker</span>
          <span className="hidden shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[11px] font-semibold text-slate-300 sm:inline">
            Partner view
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
            <Lock className="h-3 w-3" /> Read only
          </span>
          <span className="ml-auto shrink-0">
            <StatusPill />
          </span>
          {/* desktop nav */}
          <nav className="hidden gap-1 md:ml-2 md:flex">
            {tabs.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/view'}
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

      <main className="mx-auto max-w-5xl px-4 pb-[calc(6rem_+_env(safe-area-inset-bottom,0px))] pt-4 md:pb-10 sm:pt-6">
        <Outlet />
      </main>

      {/* mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t bg-slate-900/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur md:hidden">
        <div className="mx-auto grid max-w-lg grid-cols-4">
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/view'}
              className={({ isActive }) =>
                `flex min-w-0 flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
                  isActive ? 'text-slate-100' : 'text-slate-400'
                }`
              }
            >
              <Icon className="h-5 w-5" />
              <span className="w-full truncate text-center">{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
