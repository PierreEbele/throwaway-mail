import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { AuthProvider, LiveEvents, useAuth } from "./auth";
import { ToastProvider, Spinner } from "./components/ui";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/AuthPages";
import { AddressesPage } from "./pages/Addresses";
import { AddressDetailPage } from "./pages/AddressDetail";
import { AccountPage, DestinationsPage, KeysPage } from "./pages/Settings";
import { AuditPage, DomainsPage, UsersPage } from "./pages/Admin";
import { ReviewPage } from "./pages/Review";
import { ApiError } from "./api";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true, staleTime: 10_000 },
  },
});

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/login?return_to=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (admin && user.role !== "admin") return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/" element={<Protected><AddressesPage /></Protected>} />
      <Route path="/addresses/:id" element={<Protected><AddressDetailPage /></Protected>} />
      <Route path="/review" element={<Protected><ReviewPage /></Protected>} />
      <Route path="/destinations" element={<Protected><DestinationsPage /></Protected>} />
      <Route path="/keys" element={<Protected><KeysPage /></Protected>} />
      <Route path="/account" element={<Protected><AccountPage /></Protected>} />
      <Route path="/admin/domains" element={<Protected admin><DomainsPage /></Protected>} />
      <Route path="/admin/users" element={<Protected admin><UsersPage /></Protected>} />
      <Route path="/admin/audit" element={<Protected admin><AuditPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <LiveEvents />
            <App />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
