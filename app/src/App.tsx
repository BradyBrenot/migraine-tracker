import { Routes, Route } from 'react-router';
import { StoreProvider } from '@/lib/store';
import Layout from '@/components/Layout';
import Home from '@/pages/Home';
import CalendarPage from '@/pages/CalendarPage';
import Reports from '@/pages/Reports';
import History from '@/pages/History';
import Settings from '@/pages/Settings';

export default function App() {
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
