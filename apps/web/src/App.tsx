/**
 * Providers and routes.
 *
 *   /setup     first-run wizard (admin → Cloudflare token → zones → done)
 *   /login     sign in
 *   /          proxy hosts        ┐
 *   /tunnel    tunnel + live logs ├ require a session and a configured token
 *   /settings  settings           ┘
 */
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { api, isApiError } from './api/client';
import { queryKeys, useMe, useSetupStatus } from './api/queries';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ui/Toast';
import { FullPageSpinner, FullPageError } from './pages/FullPage';
import { HostsPage } from './pages/HostsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { TunnelPage } from './pages/TunnelPage';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Do not hammer the API on auth/validation errors, retry network blips.
        retry: (count, error) =>
          count < 2 && (!isApiError(error) || error.status === 0 || error.status >= 500),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

/** Sends the user to /login when any request answers 401 (expired session). */
function UnauthorizedRedirect() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(
    () =>
      api.onUnauthorized(() => {
        qc.setQueryData(queryKeys.me, null);
        if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/setup')) {
          navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
        }
      }),
    [qc, navigate, location.pathname],
  );
  return null;
}

/** Gate for the main app: setup done, logged in, Cloudflare configured. */
function RequireReady() {
  const location = useLocation();
  const status = useSetupStatus();
  const me = useMe();

  if (status.isPending || me.isPending) return <FullPageSpinner />;
  if (status.isError)
    return <FullPageError error={status.error} onRetry={() => void status.refetch()} />;
  if (me.isError) return <FullPageError error={me.error} onRetry={() => void me.refetch()} />;
  if (!status.data.userCreated) return <Navigate to="/setup" replace />;
  if (!me.data)
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!status.data.cloudflareConfigured) return <Navigate to="/setup" replace />;
  return <Outlet />;
}

export function AppRoutes() {
  return (
    <>
      <UnauthorizedRedirect />
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireReady />}>
          <Route element={<Layout />}>
            <Route index element={<HostsPage />} />
            <Route path="/tunnel" element={<TunnelPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
