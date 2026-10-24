import { NavLink, Outlet } from 'react-router';
import { Home, CalendarDays, BarChart3, List, Settings } from 'lucide-react';
import { useStore } from '@/lib/store';
import { Toaster } from '@/components/ui/sonner';

const tabs = [
  { to: '/', label: 'Log', icon: Home },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/history', label: 'History', icon: List },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const { activeAttack } = useStore();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* top bar */}
      <header className="sticky top-0 z-30 border-b bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <span className="text-lg font-bold tracking-tight">
            🌀 Migraine Tracker
          </span>
          {activeAttack && (
            <span className="ml-2 flex items-center gap-1.5 rounded-full bg-rose-950 px-3 py-1 text-xs font-semibold text-rose-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-600" />
              </span>
              Attack in progress
            </span>
          )}
          {/* desktop nav */}
          <nav className="ml-auto hidden gap-1 md:flex">
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

      <main className="mx-auto max-w-5xl px-4 pb-24 pt-6 md:pb-10">
        <Outlet />
      </main>

      {/* mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t bg-slate-900/95 backdrop-blur md:hidden">
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
