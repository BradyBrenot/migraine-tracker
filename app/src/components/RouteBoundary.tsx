import { Component, Suspense, type ReactNode } from 'react';
import { useLocation } from 'react-router';

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

/**
 * Accessible placeholder while a route chunk downloads. The surrounding
 * Layout/PartnerLayout chrome stays mounted.
 */
function RouteLoading() {
  return (
    <div role="status" aria-live="polite" className="py-10 text-center text-sm text-slate-400">
      Loading…
    </div>
  );
}

/**
 * Accessible failure state for a route chunk that could not be loaded. Reload
 * is always user-initiated, so a broken asset can never trigger a reload loop.
 */
function RouteErrorFallback() {
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-900 bg-amber-950/40 p-4 text-center text-sm text-amber-200"
    >
      <p className="font-semibold">This page could not be loaded.</p>
      <p className="mt-1 text-xs text-amber-300/80">
        A page file failed to download. Check your connection, then reload.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-3 rounded-lg bg-amber-200 px-3 py-2 text-sm font-semibold text-slate-950"
      >
        Reload
      </button>
    </div>
  );
}

class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <RouteErrorFallback />;
    return this.props.children;
  }
}

/**
 * Shared boundary for every lazily loaded route, used inside the persistent
 * writer and partner shells.
 *
 * Suspense alone only covers the loading state: a rejected `import()` throws
 * during render and would otherwise unmount the whole app. This boundary swaps
 * only the outlet content for an accessible error while the header/nav stay
 * mounted.
 *
 * It is keyed by pathname, so navigating after a failed chunk remounts the
 * boundary with fresh state and the next route renders normally instead of
 * showing a sticky error.
 */
export default function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary key={pathname}>
      <Suspense fallback={<RouteLoading />}>
        {children}
      </Suspense>
    </RouteErrorBoundary>
  );
}
