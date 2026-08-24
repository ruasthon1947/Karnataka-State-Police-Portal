import React from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import { RequireAuth } from "./components/layout/RequireAuth";
import { useLanguage } from "./context/LanguageContext";

const Chat = React.lazy(() =>
  import("./components/chat/Chat").then((module) => ({ default: module.Chat })),
);
const Login = React.lazy(() => import("./pages/Login"));
const ChangePassword = React.lazy(() => import("./pages/ChangePassword"));
const NewFIR = React.lazy(() => import("./pages/NewFIR"));
const CrimeIntelligence = React.lazy(() => import("./pages/CrimeIntelligence"));
const Dashboard = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.Dashboard })),
);
const FIRList = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.FIRList })),
);
const FIRDetail = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.FIRDetail })),
);
const AdvancedSearch = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.AdvancedSearch })),
);
const Employees = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.Employees })),
);
const MasterData = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.MasterData })),
);
const Units = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.Units })),
);
const Courts = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.Courts })),
);
const Reports = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.Reports })),
);
const Settings = React.lazy(() =>
  import("./pages/pages").then((module) => ({ default: module.Settings })),
);
const TodoList = React.lazy(() => import("./pages/TodoList"));

/**
 * Top-level routes.
 * - /login is public; password changes require a verified session.
 * - Everything else is gated by RequireAuth; first-time users see a modal
 *   that pushes them to /change-password.
 */
const App: React.FC = () => {
  const { tr } = useLanguage();
  const location = useLocation();
  // Hide auth screens on the chrome-bearing layout - they get their own full-page design.
  const isAuthScreen =
    location.pathname === "/login" ||
    location.pathname.startsWith("/change-password");

  return (
    <React.Suspense
      fallback={
        <div className="grid min-h-[100dvh] place-items-center bg-ink text-sm text-muted" role="status">
          {tr("Loading portal…", "ಪೋರ್ಟಲ್ ಲೋಡ್ ಆಗುತ್ತಿದೆ…")}
        </div>
      }
    >
      <Routes>
        {/* Auth screens (standalone layout) */}
        <Route path="/login" element={<Login />} />
        <Route
          path="/change-password"
          element={
            <RequireAuth>
              <ChangePassword />
            </RequireAuth>
          }
        />

        {/* Protected app */}
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Chat />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/todo" element={<TodoList />} />
          <Route path="/crime-intelligence" element={<CrimeIntelligence />} />

          <Route path="/fir" element={<FIRList />} />
          <Route path="/fir/new" element={<NewFIR />} />
          <Route path="/fir/:id" element={<FIRDetail />} />
          <Route path="/fir/:id/edit" element={<NewFIR />} />

          <Route path="/search" element={<AdvancedSearch />} />

          <Route path="/employees" element={<Employees />} />
          <Route path="/master-data" element={<MasterData />} />
          <Route path="/units" element={<Units />} />
          <Route path="/courts" element={<Courts />} />

          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        {import.meta.env.DEV && (
          <Route path="/_preview/crime-intelligence" element={<Navigate to="/crime-intelligence" replace />} />
        )}

        <Route
          path="*"
          element={<Navigate to={isAuthScreen ? "/login" : "/"} replace />}
        />
      </Routes>
    </React.Suspense>
  );
};

export default App;
