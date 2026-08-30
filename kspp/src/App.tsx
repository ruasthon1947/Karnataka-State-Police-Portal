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
import { ChatProvider } from "./context/ChatContext";

// Lazy loaded routes
const Chat = React.lazy(() => import("./components/chat/Chat"));
const CasePass = React.lazy(() => import("./pages/CasePass"));
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
const NotFound = React.lazy(() =>
  import("./pages/Stub").then((module) => ({ default: module.NotFound })),
);
const SessionExpired = React.lazy(() =>
  import("./pages/Stub").then((module) => ({ default: module.SessionExpired })),
);

const App: React.FC = () => {
  const { tr } = useLanguage();
  const location = useLocation();

  const isAuthScreen =
    location.pathname === "/login" ||
    location.pathname === "/session-expired" ||
    location.pathname.startsWith("/change-password") ||
    location.pathname.startsWith("/case-pass");

  return (
    <ChatProvider>
      <React.Suspense
        fallback={
          <div className="grid min-h-[100dvh] place-items-center bg-ink text-sm text-muted" role="status">
            {tr("Loading portal…", "ಪೋರ್ಟಲ್ ಲೋಡ್ ಆಗುತ್ತಿದೆ…")}
          </div>
        }
      >
        <Routes>
          {/* Public screens */}
          <Route path="/case-pass/:token" element={<CasePass />} />

          {/* Auth screens (standalone layout) */}
          <Route path="/login" element={<Login />} />
          <Route path="/session-expired" element={<SessionExpired />} />
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

          <Route path="*" element={isAuthScreen ? <Navigate to="/login" replace /> : <NotFound />} />
        </Routes>
      </React.Suspense>
    </ChatProvider>
  );
};

export default App;
