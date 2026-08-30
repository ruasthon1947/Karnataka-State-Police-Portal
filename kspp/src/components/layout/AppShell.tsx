import React, { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bot,
  Building2,
  Database,
  FilePlus2,
  FileText,
  LayoutDashboard,
  ListTodo,
  Radar,
  Scale,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  KSPPBrandMark,
  KARNATAKA_GOVERNMENT,
  KARNATAKA_GOVERNMENT_KANNADA,
  KSPP_KANNADA_NAME,
  KSPP_NAME,
  KSPP_TAGLINE,
} from "../brand/KSPPBrand";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import { FloatingCopilot } from "../chat/FloatingCopilot";
import { MorningDigestModal } from "./MorningDigestModal";
import { useFirRecords } from "../../lib/cases";
import {
  generateTasksForOfficer,
  computeGeneratedStats,
} from "../../lib/taskEngine";
import { clearDigestPending, hasDigestPending } from "../../lib/digestSession";
import { useCompletedTasks } from "../../lib/pinnedTasks";

const digestSeenKey = (employeeId: string) => `kpfir.digestSeenDate.v2.${employeeId}`;

type NavTone = "workspace" | "cases" | "reference" | "insights";
type NavEntry = {
  to: string;
  label: string;
  icon: LucideIcon;
};

const AppShell: React.FC = () => {
  const { user, logout, theme, toggleTheme, sessionExpiresAt, extendSession } =
    useAuth();
  const { language, setLanguage, tr } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [secondsLeft, setSecondsLeft] = useState(1800);
  const [showSessionWarning, setShowSessionWarning] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [portalSearch, setPortalSearch] = useState("");
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  // ── Morning Digest (once per officer per day) ───────────────────────────
  const [showDigest, setShowDigest] = useState(false);

  const { records: firRecords, loading: firsLoading } = useFirRecords();
  const today = useMemo(() => new Date(), []);
  const { isCompleted } = useCompletedTasks(user?.employeeId);

  const digestTasks = useMemo(
    () =>
      user?.name
        ? generateTasksForOfficer(user.name, firRecords, today).filter(
            (task) => !isCompleted(task.id),
          )
        : [],
    [user?.name, firRecords, today, isCompleted]
  );
  const digestStats = useMemo(
    () => computeGeneratedStats(digestTasks, today),
    [digestTasks, today]
  );

  useEffect(() => {
    if (!user?.employeeId) {
      setShowDigest(false);
      return;
    }
    const todayKey = new Date().toLocaleDateString("sv");
    const hasSeenToday = localStorage.getItem(digestSeenKey(user.employeeId)) === todayKey;
    const fromNavigation = Boolean(
      (location.state as { showDigest?: boolean } | null)?.showDigest,
    );
    setShowDigest(!hasSeenToday && (fromNavigation || hasDigestPending(user.employeeId)));
  }, [user?.employeeId, user?.isFirstLogin, location.state]);

  const dismissDigest = useCallback(() => {
    if (user?.employeeId) {
      clearDigestPending(user.employeeId);
      localStorage.setItem(digestSeenKey(user.employeeId), new Date().toLocaleDateString("sv"));
    }
    if ((location.state as { showDigest?: boolean } | null)?.showDigest) {
      navigate(location.pathname, { replace: true, state: {} });
    }
    setShowDigest(false);
  }, [user?.employeeId, location.pathname, location.state, navigate]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const markOnline = () => setIsOnline(true);
    const markOffline = () => setIsOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!sessionExpiresAt) return;
      const remaining = Math.max(
        0,
        Math.floor((sessionExpiresAt - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      setShowSessionWarning(remaining > 0 && remaining <= 300);
      if (remaining === 0) {
        logout();
        navigate("/session-expired", { replace: true });
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [sessionExpiresAt, logout, navigate]);

  const navigation = useMemo<
    Array<{ heading: string; tone: NavTone; entries: NavEntry[] }>
  >(
    () => [
      {
        heading: tr("Workspace", "ಕಾರ್ಯಸ್ಥಳ"),
        tone: "workspace",
        entries: [
          { to: "/", label: tr("AI Assistant", "ಎಐ ಸಹಾಯಕ"), icon: Bot },
          { to: "/dashboard", label: tr("Dashboard", "ಡ್ಯಾಶ್‌ಬೋರ್ಡ್"), icon: LayoutDashboard },
          { to: "/todo", label: tr("To-Do List", "ಕಾರ್ಯಗಳ ಪಟ್ಟಿ"), icon: ListTodo },
        ],
      },
      {
        heading: tr("Cases", "ಪ್ರಕರಣಗಳು"),
        tone: "cases",
        entries: [
          { to: "/fir", label: tr("FIR List", "ಎಫ್‌ಐಆರ್ ಪಟ್ಟಿ"), icon: FileText },
          { to: "/fir/new", label: tr("New FIR", "ಹೊಸ ಎಫ್‌ಐಆರ್"), icon: FilePlus2 },
          { to: "/search", label: tr("Advanced Search", "ಸುಧಾರಿತ ಹುಡುಕಾಟ"), icon: Search },
        ],
      },
      {
        heading: tr("Reference", "ಉಲ್ಲೇಖ"),
        tone: "reference",
        entries: [
          { to: "/employees", label: tr("Employees", "ಸಿಬ್ಬಂದಿ"), icon: Users },
          { to: "/master-data", label: tr("Master Data", "ಮಾಸ್ಟರ್ ಡೇಟಾ"), icon: Database },
          { to: "/units", label: tr("Units & Stations", "ಘಟಕಗಳು ಮತ್ತು ಠಾಣೆಗಳು"), icon: Building2 },
          { to: "/courts", label: tr("Courts", "ನ್ಯಾಯಾಲಯಗಳು"), icon: Scale },
        ],
      },
      {
        heading: tr("Insights", "ವಿಶ್ಲೇಷಣೆ"),
        tone: "insights",
        entries: [
          { to: "/crime-intelligence", label: tr("Crime Intelligence", "ಅಪರಾಧ ಗುಪ್ತಚರ"), icon: Radar },
          { to: "/reports", label: tr("Reports & Analytics", "ವರದಿಗಳು ಮತ್ತು ವಿಶ್ಲೇಷಣೆ"), icon: BarChart3 },
          { to: "/settings", label: tr("Settings", "ಸೆಟ್ಟಿಂಗ್‌ಗಳು"), icon: Settings },
        ],
      },
    ],
    [language, tr],
  );

  const signOut = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const sidebar = (
    <aside
      id="kspp-primary-navigation"
      className={`kspp-sidebar fixed inset-y-0 left-0 z-50 flex w-[min(88vw,300px)] shrink-0 flex-col border-r border-line bg-shell shadow-2xl transition-transform duration-200 lg:static lg:z-auto lg:w-[264px] lg:translate-x-0 lg:shadow-none ${
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
      }`}
      aria-label={tr("Primary navigation", "ಮುಖ್ಯ ಸಂಚರಣೆ")}
    >
      <div className="gov-tricolor shrink-0" aria-hidden="true" />
      <div className="flex min-h-[92px] items-center gap-3 border-b border-line px-4">
        <KSPPBrandMark size="lg" />
        <div className="min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-brand">
            {tr("KSPP · Official Portal", "KSPP · ಅಧಿಕೃತ ಪೋರ್ಟಲ್")}
          </div>
          <div className="mt-1 truncate text-[12px] font-semibold">{KSPP_NAME}</div>
          <div className="mt-0.5 truncate text-[10px] font-medium text-brand">
            {KSPP_KANNADA_NAME}
          </div>
          <div className="mt-0.5 truncate text-[8px] text-muted">{KSPP_TAGLINE}</div>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="ml-auto grid h-9 w-9 place-items-center rounded-lg border border-line text-muted lg:hidden"
          aria-label={tr("Close navigation", "ಸಂಚರಣೆ ಮುಚ್ಚಿ")}
        >
          ×
        </button>
      </div>

      <div className="border-b border-line bg-panel/60 px-4 py-2.5 text-[10px] font-medium text-muted">
        <span className="inline-flex items-center gap-1.5 font-semibold text-brand">
          <span className="h-1.5 w-1.5 rounded-full bg-sage" aria-hidden="true" />
          {tr("Government of Karnataka · Government secure workspace", "ಕರ್ನಾಟಕ ಸರ್ಕಾರ · ಸರ್ಕಾರಿ ಸುರಕ್ಷಿತ ಕಾರ್ಯಸ್ಥಳ")}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {navigation.map((group) => (
          <div className="mb-5" key={group.heading}>
            <div className="mb-2 px-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
              {group.heading}
            </div>
            <div className="space-y-1">
              {group.entries.map(({ to, label, icon: NavigationIcon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `relative flex min-h-10 items-center gap-3 rounded-lg px-2.5 text-[13px] transition ${
                      isActive
                        ? "bg-brand/10 font-semibold text-brand ring-1 ring-inset ring-brand/15 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[3px] before:rounded-r-full before:bg-brand"
                        : "text-muted hover:bg-panel hover:text-white"
                    }`
                  }
                >
                  <span className={`gov-nav-seal gov-nav-seal-${group.tone}`} aria-hidden="true">
                    <span className="gov-nav-seal-inner">
                      <NavigationIcon size={14} strokeWidth={2.15} />
                    </span>
                  </span>
                  <span className="truncate">{label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-account border-t border-line px-3 py-3">
        <div className="mb-3 rounded-lg border border-line bg-panel/50 p-2.5 lg:hidden">
          <div className="mb-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">
            {tr("Portal language", "ಪೋರ್ಟಲ್ ಭಾಷೆ")}
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink p-1">
            <button
              type="button"
              onClick={() => setLanguage("kn")}
              aria-pressed={language === "kn"}
              className={`min-h-9 rounded-md px-2 text-[11px] font-semibold transition ${
                language === "kn" ? "bg-brand text-white" : "text-muted hover:bg-panel"
              }`}
            >
              ಕನ್ನಡ
            </button>
            <button
              type="button"
              onClick={() => setLanguage("en")}
              aria-pressed={language === "en"}
              className={`min-h-9 rounded-md px-2 text-[11px] font-semibold transition ${
                language === "en" ? "bg-brand text-white" : "text-muted hover:bg-panel"
              }`}
            >
              {tr("English", "ಇಂಗ್ಲಿಷ್")}
            </button>
          </div>
        </div>
        <div className="px-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">
          {tr("Signed in as", "ಲಾಗಿನ್ ಆಗಿರುವವರು")}
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-2.5 rounded-lg border border-line/70 bg-panel/50 p-2">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white">
            {String(user?.name || "Officer")
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="sidebar-account-name truncate text-[13px] font-semibold">
              {user?.name}
            </div>
            <div className="truncate text-[10px] text-muted">
              {tr("Police personnel", "ಪೊಲೀಸ್ ಸಿಬ್ಬಂದಿ")} · {user?.employeeId}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="sidebar-theme-button mt-2.5 flex min-h-10 w-full items-center gap-2.5 rounded-lg border border-line px-3 text-[12px] transition"
        >
          <span aria-hidden="true">◐</span>
          {theme === "light"
            ? tr("Switch to dark mode", "ಡಾರ್ಕ್ ಮೋಡ್‌ಗೆ ಬದಲಿಸಿ")
            : tr("Switch to light mode", "ಲೈಟ್ ಮೋಡ್‌ಗೆ ಬದಲಿಸಿ")}
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-[100dvh] min-h-0 overflow-hidden bg-ink text-white">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-lg transition focus:translate-y-0"
      >
        {tr("Skip to main content", "ಮುಖ್ಯ ವಿಷಯಕ್ಕೆ ಹೋಗಿ")}
      </a>
      {sidebar}

      {mobileMenuOpen && (
        <button
          type="button"
          aria-label={tr("Close navigation", "ಸಂಚರಣೆ ಮುಚ್ಚಿ")}
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px] lg:hidden"
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="gov-tricolor shrink-0 lg:hidden" aria-hidden="true" />
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-gov-navy px-3 py-1 text-[10px] font-medium text-white/80 sm:px-4">
          <span className="min-w-0 truncate">
            <strong className="font-semibold text-white">{KARNATAKA_GOVERNMENT_KANNADA}</strong>
            <span className="hidden text-white/45 sm:inline"> · {KARNATAKA_GOVERNMENT}</span>
          </span>
          <span className="hidden md:inline">
            {tr("Karnataka State Police", "ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            {tr("Secure session", "ಸುರಕ್ಷಿತ ಸೆಷನ್")}
          </span>
        </div>

        <header className="flex min-h-[62px] min-w-0 shrink-0 items-center gap-2 border-b border-line bg-shell px-2.5 sm:gap-3 sm:px-4 lg:px-5">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-panel text-lg lg:hidden"
            aria-controls="kspp-primary-navigation"
            aria-expanded={mobileMenuOpen}
            aria-label={tr("Open navigation", "ಸಂಚರಣೆ ತೆರೆಯಿರಿ")}
          >
            ☰
          </button>

          <form
            className="kspp-mobile-search relative min-w-0 flex-1 sm:max-w-[540px]"
            onSubmit={(event) => {
              event.preventDefault();
              const query = portalSearch.trim();
              if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
            }}
            role="search"
          >
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted"
              aria-hidden="true"
            >
              ⌕
            </span>
            <input
              value={portalSearch}
              onChange={(event) => setPortalSearch(event.target.value)}
              className="h-10 w-full rounded-lg border border-line bg-panel pl-9 pr-3 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
              placeholder={tr(
                "Search FIRs, crime numbers, names, sections...",
                "ಎಫ್‌ಐಆರ್, ಅಪರಾಧ ಸಂಖ್ಯೆ, ಹೆಸರು, ಸೆಕ್ಷನ್ ಹುಡುಕಿ...",
              )}
              aria-label={tr("Search portal", "ಪೋರ್ಟಲ್ ಹುಡುಕಿ")}
            />
          </form>

          <div className="ml-auto hidden whitespace-nowrap text-[11px] text-muted xl:block">
            {new Date().toLocaleDateString(language === "kn" ? "kn-IN" : "en-IN", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </div>

          <label className="sr-only" htmlFor="portal-language">
            {tr("Language", "ಭಾಷೆ")}
          </label>
          <select
            id="portal-language"
            value={language}
            onChange={(event) => setLanguage(event.target.value as "en" | "kn")}
            className="hidden h-10 rounded-lg border border-line bg-panel px-2.5 text-[12px] outline-none focus:border-brand sm:block"
          >
            <option value="en">{tr("English", "ಇಂಗ್ಲಿಷ್")}</option>
            <option value="kn">ಕನ್ನಡ</option>
          </select>

          <button
            type="button"
            onClick={toggleTheme}
            className="hidden h-10 rounded-lg border border-line bg-panel px-3 text-[12px] transition hover:border-brand/40 md:block"
            aria-label={tr("Toggle colour theme", "ಬಣ್ಣದ ಥೀಮ್ ಬದಲಾಯಿಸಿ")}
          >
            <span aria-hidden="true">◐</span>{" "}
            {theme === "light" ? tr("Dark", "ಡಾರ್ಕ್") : tr("Light", "ಲೈಟ್")}
          </button>

          <button
            type="button"
            onClick={signOut}
            className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[12px] text-muted transition hover:border-rose/30 hover:text-rose sm:min-w-[88px] sm:px-3"
            aria-label={tr("Logout", "ಲಾಗ್ ಔಟ್")}
          >
            <span aria-hidden="true">⇥</span>
            <span className="hidden sm:inline">{tr("Logout", "ಲಾಗ್ ಔಟ್")}</span>
          </button>
        </header>

        {!isOnline && (
          <div className="border-b border-amber/30 bg-amber/10 px-4 py-2 text-center text-xs font-medium text-amber" role="status" aria-live="polite">
            {tr(
              "You are offline. Browser drafts remain available; sync, uploads and messages will resume after reconnecting.",
              "ನೀವು ಆಫ್‌ಲೈನ್‌ನಲ್ಲಿದ್ದೀರಿ. ಬ್ರೌಸರ್ ಕರಡುಗಳು ಲಭ್ಯವಿವೆ; ಮರುಸಂಪರ್ಕದ ನಂತರ ಸಿಂಕ್, ಅಪ್‌ಲೋಡ್ ಮತ್ತು ಸಂದೇಶಗಳು ಮುಂದುವರಿಯುತ್ತವೆ.",
            )}
          </div>
        )}

        <main id="main-content" className="min-h-0 flex-1 overflow-auto bg-ink">
          <Outlet />
        </main>

        <footer className="hidden h-7 shrink-0 items-center justify-between border-t border-line bg-shell px-5 text-[9px] font-medium text-muted md:flex">
          <span>{KSPP_TAGLINE}</span>
          <span>
            {tr(
              "Official use only · Activity may be monitored",
              "ಅಧಿಕೃತ ಬಳಕೆಗೆ ಮಾತ್ರ · ಚಟುವಟಿಕೆಯನ್ನು ಮೇಲ್ವಿಚಾರಣೆ ಮಾಡಬಹುದು",
            )}
          </span>
        </footer>
      </div>

      {/* ── Morning Digest (z-50) ── */}
      {showDigest && user && (
        <MorningDigestModal
          officerName={user.name}
          employeeId={user.employeeId}
          tasks={digestTasks}
          stats={digestStats}
          isLoading={firsLoading}
          onClose={dismissDigest}
        />
      )}

      {/* ── Session Expiry Warning Modal (z-60) ── */}
      {showSessionWarning && (
        <div
          className="modal-backdrop fixed inset-0 z-[60] grid place-items-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="session-warning-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-shell p-6 shadow-soft">
            <div className="flex items-start gap-3">
              <KSPPBrandMark size="md" decorative />
              <div>
                <div id="session-warning-title" className="text-lg font-semibold">
                  {tr("Session expiring soon", "ಸೆಷನ್ ಶೀಘ್ರದಲ್ಲೇ ಮುಕ್ತಾಯಗೊಳ್ಳುತ್ತದೆ")}
                </div>
                <p className="mt-2 text-sm text-muted">
                  {tr(
                    "For security, your session will end automatically.",
                    "ಭದ್ರತೆಗಾಗಿ ನಿಮ್ಮ ಸೆಷನ್ ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಮುಕ್ತಾಯಗೊಳ್ಳುತ್ತದೆ.",
                  )}
                </p>
              </div>
            </div>
            <div className="num mt-5 text-3xl font-semibold">
              {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:
              {String(secondsLeft % 60).padStart(2, "0")}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={signOut}
                className="rounded-lg border border-line px-4 py-2 text-sm"
              >
                {tr("Logout", "ಲಾಗ್ ಔಟ್")}
              </button>
              <button
                type="button"
                onClick={async () => {
                  const result = await extendSession();
                  if (result.ok) {
                    setShowSessionWarning(false);
                  } else {
                    navigate("/session-expired", { replace: true });
                  }
                }}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white"
              >
                {tr("Continue session", "ಸೆಷನ್ ಮುಂದುವರಿಸಿ")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Floating AI Copilot ── */}
      <FloatingCopilot />
    </div>
  );
};

export default AppShell;
