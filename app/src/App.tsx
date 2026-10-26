import { Routes, Route, useLocation } from 'react-router';
import { ReadOnlyStoreProvider, StoreProvider } from '@/lib/store';
import Layout from '@/components/Layout';
import PartnerLayout from '@/components/PartnerLayout';
import Home from '@/pages/Home';
import CalendarPage from '@/pages/CalendarPage';
import Reports from '@/pages/Reports';
import History from '@/pages/History';
import Settings from '@/pages/Settings';
import PartnerHome from '@/pages/PartnerHome';

/**
 * Two route trees with different store composition:
 * - `/view` (and every nested viewer route) mounts ONLY the read-only
 *   provider, so a partner browser can never upload, enqueue writes, or touch
 *   the writer's localStorage cache.
 * - every other route mounts ONLY the normal provider, exactly as before.
 */
export default function App() {
  const { pathname } = useLocation();
  const isPartnerView = pathname === '/view' || pathname.startsWith('/view/');

  if (isPartnerView) {
    return (
      <ReadOnlyStoreProvider>
        <Routes>
          <Route element={<PartnerLayout />}>
            <Route path="/view" element={<PartnerHome />} />
            <Route path="/view/calendar" element={<CalendarPage />} />
            <Route path="/view/reports" element={<Reports />} />
            <Route path="/view/history" element={<History />} />
          </Route>
        </Routes>
      </ReadOnlyStoreProvider>
    );
  }

  return (
    <StoreProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </StoreProvider>
  );
}
