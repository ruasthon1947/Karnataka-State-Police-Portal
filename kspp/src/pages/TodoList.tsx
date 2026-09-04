import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import {
  ClipboardList, AlertCircle, Clock, Calendar,
  CheckCircle2, CloudDownload, Plus, Building2, Activity, Trash2, RefreshCw,
  ChevronDown, ChevronUp, Zap, Shield,
  Pin, Check, X
} from "lucide-react";
import {
  TodoTask,
  TodoStats,
  fetchTodos,
  fetchStats,
  createTodo,
  updateTodo,
  deleteTodo,
  importTodos,
} from "../lib/todoApi";
import { useFirRecords } from "../lib/cases";
import {
  generateTasksForOfficer,
  computeGeneratedStats,
  GeneratedTask,
  TaskPriority,
  TaskCategory,
  displayGeneratedTaskTitle,
  displayGeneratedTaskContext,
} from "../lib/taskEngine";
import { useCompletedTasks, usePinnedTasks } from "../lib/pinnedTasks";

// ─── Local Sub-components ─────────────────────────────────────────────────────

const Card: React.FC<{ children: React.ReactNode; className?: string; onClick?: (e: React.MouseEvent) => void }> = ({
  children,
  className = "",
  onClick,
}) => (
  <div
    onClick={onClick}
    className={`bg-shell border border-line rounded-xl ${onClick ? "cursor-pointer transition hover:border-brand/40" : ""
      } ${className}`}
  >
    {children}
  </div>
);

const StatTile: React.FC<{
  label: string;
  value: number | string;
  accent?: string;
  sub?: string;
  icon?: React.ReactNode;
  colorTheme?: "blue" | "red" | "amber" | "green" | "gray";
}> = ({ label, value, accent = "text-slate-900 dark:text-slate-50", sub, icon, colorTheme = "blue" }) => {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-line bg-shell p-4 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 w-full">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            {label}
          </span>
          <span className={`mt-3 text-3xl font-semibold tabular-nums leading-none ${accent}`}>
            {value}
          </span>
        </div>
      </div>

      {sub && (
        <div className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
          <span>{sub}</span>
        </div>
      )}
    </div>
  );
};

const getInitials = (name: string) => {
  if (!name) return "ST";
  const parts = name.trim().split(/\s+/);
  return parts.map((n) => n[0]).join("").substring(0, 2).toUpperCase();
};

const TaskDescription: React.FC<{ text: string }> = ({ text }) => {
  const { tr } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  if (text.length < 120) {
    return <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{text}</p>;
  }
  return (
    <div className="space-y-1">
      <p className={`text-sm text-slate-600 dark:text-slate-300 leading-relaxed transition-all duration-200 ${expanded ? "" : "line-clamp-2"}`}>
        {text}
      </p>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="inline-flex items-center gap-1 text-xs font-bold text-brand dark:text-steel hover:text-brand/80 dark:hover:text-steel/80 transition-colors focus:outline-none"
      >
        <span>{expanded ? tr("Show Less", "ಕಡಿಮೆ ತೋರಿಸಿ") : tr("Show More", "ಇನ್ನಷ್ಟು ತೋರಿಸಿ")}</span>
        {expanded ? <ChevronUp size={12} strokeWidth={2.5} /> : <ChevronDown size={12} strokeWidth={2.5} />}
      </button>
    </div>
  );
};

// ─── Priority Badges ──────────────────────────────────────────────────────────

const PriorityBadge: React.FC<{ priority: TaskPriority }> = ({ priority }) => {
  const { tr } = useLanguage();
  const styles: Record<TaskPriority, { bg: string; text: string; dot: string; border: string }> = {
    critical: {
      bg: "bg-rose-50 dark:bg-rose/10",
      text: "text-rose-700 dark:text-rose-200 font-bold",
      dot: "bg-rose animate-pulse",
      border: "border-rose-200 dark:border-rose/20",
    },
    high: {
      bg: "bg-amber-50 dark:bg-amber/10",
      text: "text-amber-700 dark:text-amber-200 font-bold",
      dot: "bg-amber",
      border: "border-amber-200 dark:border-amber/20",
    },
    medium: {
      bg: "bg-blue-50 dark:bg-brand/10",
      text: "text-brand dark:text-steel font-bold",
      dot: "bg-brand dark:bg-steel",
      border: "border-brand/25 dark:border-steel/20",
    },
    low: {
      bg: "bg-slate-100 dark:bg-panel",
      text: "text-slate-700 dark:text-slate-200 font-semibold",
      dot: "bg-slate-500 dark:bg-muted/40",
      border: "border-slate-300 dark:border-line/60",
    },
  };

  const style = styles[priority] || styles.low;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider border ${style.bg} ${style.text} ${style.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {tr(priority, { low: "ಕಡಿಮೆ", medium: "ಮಧ್ಯಮ", high: "ಹೆಚ್ಚು", critical: "ನಿರ್ಣಾಯಕ" }[priority])}
    </span>
  );
};

const formatTaskTitle = (task: GeneratedTask) => task.title;

type PendingTaskAction =
  | { kind: "complete-generated"; task: GeneratedTask }
  | { kind: "complete-manual"; task: TodoTask }
  | { kind: "delete-manual"; task: TodoTask };

// ─── Generated Task Card ──────────────────────────────────────────────────────

const GeneratedTaskCard: React.FC<{
  task: GeneratedTask;
  today: Date;
  isPinned: boolean;
  onTogglePinned: () => void;
  onComplete: () => void;
}> = ({ task, today, isPinned, onTogglePinned, onComplete }) => {
  const navigate = useNavigate();
  const { language, tr } = useLanguage();
  const todayIso = today.toLocaleDateString("sv");
  const isOverdue = task.dueDate ? task.dueDate < todayIso : false;
  const openCase = () => navigate(`/fir/${encodeURIComponent(task.linkedFirNumber)}`);

  return (
    <article className="group block">
      <Card
        className="flex flex-col gap-3 p-4 transition hover:border-brand/40 hover:bg-panel sm:flex-row sm:items-center"
      >
        <div className="flex-1 min-w-0 flex items-start gap-3">
          <button
            type="button"
            role="checkbox"
            aria-checked={false}
            onClick={(event) => {
              event.stopPropagation();
              onComplete();
            }}
            className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border-2 border-line bg-panel text-transparent transition-colors hover:border-brand hover:text-brand/50"
            aria-label={tr(`Complete ${formatTaskTitle(task)}`, `${displayGeneratedTaskTitle(task, "kn")} ಪೂರ್ಣಗೊಳಿಸಿ`)}
          >
            <Check size={12} strokeWidth={3} className="opacity-0 transition-opacity group-hover:opacity-40" />
          </button>

          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <h3>
                <button type="button" onClick={openCase} className="text-left text-sm font-bold tracking-tight text-ink transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-white dark:hover:text-steel">
                  {displayGeneratedTaskTitle(task, language)}
                </button>
              </h3>
              <div className="flex items-center gap-1.5 flex-wrap">
                <PriorityBadge priority={task.priority} />
                {isOverdue && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:border-rose/25 dark:bg-rose/10 dark:text-rose">
                    <Clock size={10} className="animate-pulse" />
                    {tr("Overdue", "ಅವಧಿ ಮೀರಿದೆ")}
                  </span>
                )}
              </div>
            </div>

            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300 font-medium">
              {displayGeneratedTaskContext(task, language)}
            </p>
          </div>
        </div>

        {/* Pin and Action Panel */}
        <div className="flex shrink-0 items-center justify-end gap-1.5 self-end sm:self-center">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTogglePinned();
            }}
            className={`grid h-8 w-8 place-items-center rounded-lg border transition-colors ${isPinned
                ? "border-amber/30 bg-amber/10 text-amber"
                : "border-line text-muted hover:bg-panel hover:text-amber"
              }`}
            aria-label={isPinned ? tr(`Unpin ${task.title}`, `${displayGeneratedTaskTitle(task, "kn")} ಪಿನ್ ತೆಗೆದುಹಾಕಿ`) : tr(`Pin ${task.title}`, `${displayGeneratedTaskTitle(task, "kn")} ಪಿನ್ ಮಾಡಿ`)}
            title={isPinned ? tr("Unpin task", "ಕಾರ್ಯದ ಪಿನ್ ತೆಗೆದುಹಾಕಿ") : tr("Pin task", "ಕಾರ್ಯ ಪಿನ್ ಮಾಡಿ")}
          >
            <Pin size={14} fill={isPinned ? "currentColor" : "none"} className={isPinned ? "rotate-45 transition-transform" : "transition-transform"} />
          </button>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openCase();
            }}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-panel hover:text-brand"
            title={tr("View Case Details", "ಪ್ರಕರಣದ ವಿವರಗಳನ್ನು ನೋಡಿ")}
            aria-label={tr(`View case details for FIR ${task.displayFirNumber}`, `ಎಫ್‌ಐಆರ್ ${task.displayFirNumber} ಪ್ರಕರಣದ ವಿವರಗಳನ್ನು ನೋಡಿ`)}
          >
            <Activity size={14} />
          </button>
        </div>
      </Card>
    </article>
  );
};

// ─── Manual / Persisted Task Card ──────────────────────────────────────────────

const ManualTaskCard: React.FC<{
  task: TodoTask;
  isPinned: boolean;
  isOverdue: boolean;
  isDueToday: boolean;
  isDueTomorrow: boolean;
  onComplete: () => void;
  onDelete: () => void;
  onTogglePinned: () => void;
}> = ({ task, isPinned, isOverdue, isDueToday, isDueTomorrow, onComplete, onDelete, onTogglePinned }) => {
  const { language, tr } = useLanguage();
  const addedAtLabel = task.source === "manual" && task.createdAt
    ? tr(`Added ${new Date(task.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`, `${new Date(task.createdAt).toLocaleString("kn-IN", { dateStyle: "medium", timeStyle: "short" })} ಸೇರಿಸಲಾಗಿದೆ`)
    : "";

  return (
    <Card
      className={`flex flex-col gap-3 p-4 transition hover:border-brand/40 hover:bg-panel sm:flex-row sm:items-center ${task.status === "completed" ? "opacity-60" : ""}`}
    >
      <div className="flex-1 min-w-0 flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={task.status === "completed"}
          onClick={(event) => {
            event.stopPropagation();
            if (task.status === "completed") return;
            onComplete();
          }}
          className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-lg border-2 transition-all duration-200 ${task.status === "completed"
              ? "border-2 border-brand bg-brand text-white scale-95 shadow-sm shadow-brand/20"
              : "border-slate-400 bg-white text-transparent hover:border-brand hover:bg-brand/5 hover:text-brand/40 dark:border-slate-500 dark:bg-panel"
            }`}
          aria-label={`Complete ${task.title}`}
        >
          <Check size={12} strokeWidth={3} className={task.status === "completed" ? "scale-100" : "scale-75 opacity-0 hover:opacity-100 hover:scale-100 transition-all duration-200"} />
        </button>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-sm font-bold tracking-tight ${task.status === "completed" ? "line-through text-muted" : "text-ink dark:text-white"
              }`}>
              {task.title}
            </h3>

            <div className="flex items-center gap-1.5 flex-wrap">
              <PriorityBadge priority={task.priority} />

              {task.source === "google_sheets" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  {tr("Imported", "ಆಮದು ಮಾಡಲಾಗಿದೆ")}
                </span>
              )}

              {isOverdue && task.status !== "completed" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:border-rose/25 dark:bg-rose/10 dark:text-rose">
                  <Clock size={10} className="animate-pulse" />
                  {tr("Overdue", "ಅವಧಿ ಮೀರಿದೆ")}
                </span>
              )}

              {isDueToday && task.status !== "completed" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:border-amber/25 dark:bg-amber/10 dark:text-amber-200">
                  {tr("Due Today", "ಇಂದು ಗಡುವು")}
                </span>
              )}

              {isDueTomorrow && task.status !== "completed" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/5 dark:text-steel">
                  {tr("Due Tomorrow", "ನಾಳೆ ಗಡುವು")}
                </span>
              )}
            </div>
          </div>

          <TaskDescription text={task.description} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 text-xs font-semibold text-muted dark:text-muted/80">
            {task.dueDate && (
              <span className={`flex items-center gap-1.5 ${isOverdue ? "text-rose font-bold" : (isDueToday || isDueTomorrow) ? "text-amber font-bold" : ""}`}>
                <Calendar size={13} strokeWidth={2.5} />
                {new Date(task.dueDate).toLocaleDateString(language === "kn" ? "kn-IN" : "en-IN")}
              </span>
            )}

            {task.policeStation && (
              <span className="flex items-center gap-1.5 border-l border-line/40 pl-4">
                <Building2 size={13} strokeWidth={2} className="text-muted/60" />
                {task.policeStation}
              </span>
            )}

            {task.assignedTo && (
              <span className="flex items-center gap-1.5 border-l border-line/40 pl-4">
                <span className="w-5 h-5 rounded-full bg-brand/10 text-brand dark:text-steel flex items-center justify-center text-[9px] font-bold border border-brand/20">
                  {getInitials(task.assignedTo)}
                </span>
                <span className="text-muted dark:text-muted/80">{task.assignedTo}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5 self-end sm:self-center">
        {addedAtLabel && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600 dark:border-line dark:bg-panel/60 dark:text-slate-300">
            <Clock size={10} strokeWidth={2.5} />
            {addedAtLabel}
          </span>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDelete}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-rose/10 hover:text-rose"
            aria-label={`Delete ${task.title}`}
            title={tr("Delete task", "ಕಾರ್ಯ ಅಳಿಸಿ")}
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            onClick={onTogglePinned}
            className={`grid h-8 w-8 place-items-center rounded-lg border transition-colors ${isPinned
                ? "border-amber/30 bg-amber/10 text-amber"
                : "border-line text-muted hover:bg-panel hover:text-amber"
              }`}
            aria-label={isPinned ? tr(`Unpin ${task.title}`, `${task.title} ಪಿನ್ ತೆಗೆದುಹಾಕಿ`) : tr(`Pin ${task.title}`, `${task.title} ಪಿನ್ ಮಾಡಿ`)}
            title={isPinned ? tr("Unpin task", "ಕಾರ್ಯದ ಪಿನ್ ತೆಗೆದುಹಾಕಿ") : tr("Pin task", "ಕಾರ್ಯ ಪಿನ್ ಮಾಡಿ")}
          >
            <Pin size={14} fill={isPinned ? "currentColor" : "none"} className={isPinned ? "rotate-45" : ""} />
          </button>
        </div>
      </div>
    </Card>
  );
};

// ─── Empty State Sub-component ────────────────────────────────────────────────

const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
}> = ({ icon, title, description }) => (
  <Card className="flex flex-col items-center justify-center border-dashed bg-panel/20 px-6 py-16 text-center">
    <div className="mb-4 grid h-12 w-12 place-items-center rounded-lg border border-line bg-shell text-brand">
      {icon}
    </div>
    <h3 className="text-lg font-bold text-ink dark:text-white tracking-tight mb-2">
      {title}
    </h3>
    <p className="text-sm text-muted dark:text-muted/80 max-w-sm leading-relaxed">
      {description}
    </p>
  </Card>
);

// ─── Main Component ───────────────────────────────────────────────────────────

const TodoList: React.FC = () => {
  const { user } = useAuth();
  const { language, tr } = useLanguage();
  const { isPinned, togglePinned } = usePinnedTasks(user?.employeeId);
  const { isCompleted, markCompleted } = useCompletedTasks(user?.employeeId);

  // ── FIR data (for task generation) ──
  const { records: firRecords, loading: firsLoading } = useFirRecords();
  const today = useMemo(() => new Date(), []);

  // ── Generated tasks (pure, always in sync with FIRs) ──
  const generatedTasks = useMemo(
    () =>
      user?.name
        ? generateTasksForOfficer(user.name, firRecords, today)
        : [],
    [user?.name, firRecords, today]
  );
  const generatedStats = useMemo(
    () => computeGeneratedStats(generatedTasks.filter((task) => !isCompleted(task.id)), today),
    [generatedTasks, today, isCompleted]
  );
  const activeGeneratedTasks = useMemo(
    () => generatedTasks.filter((task) => !isCompleted(task.id)),
    [generatedTasks, isCompleted],
  );

  const groupedGeneratedTasks = useMemo(() => {
    const groups: Array<{ category: TaskCategory; label: string; dot: string; tasks: GeneratedTask[] }> = [
      { category: "chargesheet", label: "Chargesheet Deadlines", dot: "bg-rose", tasks: [] },
      { category: "court", label: "Court Appearances", dot: "bg-brand dark:bg-steel", tasks: [] },
      { category: "followup", label: "Stalled Investigations", dot: "bg-amber", tasks: [] },
      { category: "investigation", label: "Active Investigations", dot: "bg-muted/60", tasks: [] },
    ];
    for (const task of activeGeneratedTasks) {
      groups.find((group) => group.category === task.category)?.tasks.push(task);
    }
    return groups.filter((group) => group.tasks.length > 0);
  }, [activeGeneratedTasks]);
  const pinnedGeneratedTasks = useMemo(
    () => activeGeneratedTasks.filter((task) => isPinned(task.id)),
    [activeGeneratedTasks, isPinned],
  );

  // ── Persisted / manual tasks (legacy - read from TodoTasks sheet) ──
  const [persistedTasks, setPersistedTasks] = useState<TodoTask[]>([]);
  const [persistedStats, setPersistedStats] = useState<TodoStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  // Sync UI state
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [, setTick] = useState(0); // used to force relative-time re-rendering
  const visibleManualTasks = useMemo(
    () => persistedTasks.filter((task) => task.status !== "completed" && !isPinned(task.taskId)),
    [persistedTasks, isPinned],
  );
  const pinnedManualTasks = useMemo(
    () => persistedTasks.filter((task) => task.status !== "completed" && isPinned(task.taskId)),
    [persistedTasks, isPinned],
  );
  const pinnedTaskCount = pinnedGeneratedTasks.length + pinnedManualTasks.length;

  // ── UI state ──
  const [activeTab, setActiveTab] = useState<"auto" | "manual" | "pinned" | "station">("auto");
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  // ── New Task Modal ──
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [newTask, setNewTask] = useState<Partial<TodoTask>>({
    title: "",
    description: "",
    priority: "medium",
    dueDate: "",
  });
  const [pendingAction, setPendingAction] = useState<PendingTaskAction | null>(null);

  const isAdmin = user?.role === "Inspector" || user?.role === "SP";

  // ── Load persisted tasks ──
  const loadPersisted = async () => {
    setLoading(true);
    setError("");
    try {
      const [todosResult, statsResult] = await Promise.allSettled([fetchTodos(), fetchStats()]);
      let anySuccess = false;
      if (todosResult.status === "fulfilled" && todosResult.value.ok) {
        setPersistedTasks(todosResult.value.todos);
        anySuccess = true;
      }
      if (statsResult.status === "fulfilled" && statsResult.value.ok) {
        setPersistedStats(statsResult.value.stats);
        anySuccess = true;
      }
      if (anySuccess) {
        setLastSynced(new Date());
      }
      if (todosResult.status === "rejected" && statsResult.status === "rejected") {
        throw todosResult.reason;
      }
    } catch (err: any) {
      setError(err.message || "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPersisted();
  }, []);

  // Update the relative-time display every 30s while we have a lastSynced timestamp
  useEffect(() => {
    if (!lastSynced) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [lastSynced]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await loadPersisted();
    } finally {
      setSyncing(false);
    }
  };

  // ── Handlers for persisted tasks ──
  const handleImport = async () => {
    setImporting(true);
    setError("");
    try {
      const result = await importTodos();
      if (result.ok) {
        await loadPersisted();
        alert(`Successfully imported ${result.imported} tasks from Google Sheets.`);
      }
    } catch (err: any) {
      setError(err.message || "Failed to import tasks");
    } finally {
      setImporting(false);
    }
  };

  const handleStatusChange = async (task: TodoTask, newStatus: string) => {
    const previousStatus = task.status;
    try {
      setPersistedTasks((current) =>
        current.map((t) =>
          t.taskId === task.taskId ? { ...t, status: newStatus as any } : t
        )
      );
      await updateTodo(task.taskId, { status: newStatus as any });
      void fetchStats()
        .then((s) => { if (s.ok) setPersistedStats(s.stats); })
        .catch(() => undefined);
    } catch (err: any) {
      setPersistedTasks((current) =>
        current.map((item) =>
          item.taskId === task.taskId ? { ...item, status: previousStatus } : item,
        ),
      );
      setError(err.message || "Failed to update task");
    }
  };

  const handleDelete = async (task: TodoTask) => {
    if (!task?.taskId) {
      return;
    }

    const taskId = task.taskId;
    const employeeId = user?.employeeId;

    setError("");

    try {
      // Perform backend delete first; only update UI after success.
      await deleteTodo(taskId);

      // Remove from page after backend confirms deletion
      setPersistedTasks((current) => current.filter((item) => item.taskId !== taskId));

      // Clean up any local storage references
      if (employeeId) {
        const pinnedKey = `kpfir.pinnedTasks.v1.${employeeId}`;
        const completedKey = `kpfir.completedTasks.v1.${employeeId}`;
        try {
          const pinnedIds = JSON.parse(localStorage.getItem(pinnedKey) || "[]");
          const completedIds = JSON.parse(localStorage.getItem(completedKey) || "[]");
          if (Array.isArray(pinnedIds)) {
            localStorage.setItem(pinnedKey, JSON.stringify(pinnedIds.filter((id: string) => id !== taskId)));
          }
          if (Array.isArray(completedIds)) {
            localStorage.setItem(completedKey, JSON.stringify(completedIds.filter((id: string) => id !== taskId)));
          }
        } catch {
          // Ignore local-storage cleanup failures
        }
      }

      // Refresh stats after delete
      void fetchStats()
        .then((s) => { if (s.ok) setPersistedStats(s.stats); })
        .catch(() => undefined);

    } catch (err: any) {
      // On failure, show error and do not remove the task from the UI (it will remain)
      setError(err.message || "Failed to delete task");
    }
  };

  const confirmPendingAction = async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);

    if (action.kind === "complete-generated") {
      markCompleted(action.task.id);
      return;
    }
    if (action.kind === "complete-manual") {
      await handleStatusChange(action.task, "completed");
      return;
    }
    await handleDelete(action.task);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await createTodo({
        ...newTask,
        assignedTo: user?.employeeId,
      });
      if (created.ok) {
        setPersistedTasks((current) => [created.todo, ...current]);
        setShowNewTaskModal(false);
        setNewTask({ title: "", description: "", priority: "medium", dueDate: "" });
        void fetchStats()
          .then((s) => { if (s.ok) setPersistedStats(s.stats); })
          .catch(() => undefined);
      }
    } catch (err: any) {
      alert(err.message || "Failed to create task");
    }
  };

  // ── Derived from persisted stats ──
  const overdueSet = useMemo(() => new Set(persistedStats?.overdueTasks || []), [persistedStats]);
  const dueTodaySet = useMemo(() => new Set(persistedStats?.dueTodayTasks || []), [persistedStats]);
  const dueTomorrowSet = useMemo(() => new Set(persistedStats?.dueTomorrowTasks || []), [persistedStats]);

  const isDataLoading = firsLoading || loading;

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="relative">
      {pendingAction && (() => {
        const deleting = pendingAction.kind === "delete-manual";
        const title = pendingAction.task.title;
        return (
          <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="task-action-title">
            <div className="w-full max-w-sm overflow-hidden rounded-xl border border-line bg-shell shadow-soft">
              <div className="p-5">
                <div className="flex items-start gap-3">
                  <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${deleting ? "bg-rose/10 text-rose" : "bg-sage/10 text-sage"}`}>
                    {deleting ? <Trash2 size={18} /> : <CheckCircle2 size={19} />}
                  </div>
                  <div className="min-w-0">
                    <h3 id="task-action-title" className="text-base font-bold text-ink dark:text-white">
                      {deleting ? tr("Delete this task?", "ಈ ಕಾರ್ಯವನ್ನು ಅಳಿಸಬೇಕೆ?") : tr("Mark as completed?", "ಪೂರ್ಣಗೊಂಡಿದೆ ಎಂದು ಗುರುತಿಸಬೇಕೆ?")}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted">
                      {deleting ? tr("It will be removed from the shared list.", "ಇದನ್ನು ಹಂಚಿಕೆಯ ಪಟ್ಟಿಯಿಂದ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ.") : tr("It will leave your active task list.", "ಇದು ನಿಮ್ಮ ಸಕ್ರಿಯ ಕಾರ್ಯಪಟ್ಟಿಯಿಂದ ಹೊರಹೋಗುತ್ತದೆ.")}
                    </p>
                  </div>
                </div>
                <p className="mt-4 line-clamp-2 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm font-semibold text-ink">
                  {title}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2.5">
                  <button type="button" onClick={() => setPendingAction(null)} className="h-9 rounded-lg border border-line px-4 text-sm font-semibold text-muted transition-colors hover:bg-panel hover:text-ink">
                    {tr("Keep task", "ಕಾರ್ಯ ಉಳಿಸಿಕೊಳ್ಳಿ")}
                  </button>
                  <button type="button" onClick={() => void confirmPendingAction()} className={`h-9 rounded-lg px-4 text-sm font-semibold text-white transition-colors ${deleting ? "bg-rose hover:bg-rose/90" : "bg-brand hover:bg-brand/90"}`}>
                    {deleting ? tr("Delete", "ಅಳಿಸಿ") : tr("Complete", "ಪೂರ್ಣಗೊಳಿಸಿ")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="mx-auto w-full max-w-[1500px] space-y-5 p-5 md:p-6">

        {/* ── Dashboard Header ─────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-ink">
              {tr("Officer To-Do List", "ಅಧಿಕಾರಿಗಳ ಕಾರ್ಯಗಳ ಪಟ್ಟಿ")}
            </h1>
            <p className="mt-1 text-sm text-muted dark:text-muted/80">
              {tr(
                "Tasks from your assigned FIRs, plus anything added manually.",
                "ನಿಮ್ಮ ಸಕ್ರಿಯ ಮತ್ತು ನಿಯೋಜಿತ ಎಫ್‌ಐಆರ್‌ಗಳಿಂದ ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಪಡೆದ ಬುದ್ಧಿಮತ್ತೆ ಆಧಾರಿತ ಕಾರ್ಯಗಳು."
              )}
            </p>
            {error && (
              <div className="mt-3 flex max-w-md items-center gap-2 rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-xs font-semibold text-rose">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start md:self-center shrink-0">
            {/* Sync control: manual refresh + last-synced */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSync()}
                disabled={syncing}
                className={`grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition-colors ${syncing ? "cursor-wait opacity-70" : "hover:bg-panel hover:text-ink"}`}
                aria-label={tr("Sync latest tasks", "ಇತ್ತೀಚಿನ ಕಾರ್ಯಗಳನ್ನು ಸಿಂಕ್ ಮಾಡಿ")}
                title={tr("Sync latest tasks", "ಇತ್ತೀಚಿನ ಕಾರ್ಯಗಳನ್ನು ಸಿಂಕ್ ಮಾಡಿ")}
              >
                <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
              </button>
              <div className="hidden text-[11px] text-muted sm:block">
                <div title={lastSynced ? lastSynced.toLocaleString() : "Never"}>
                  {lastSynced ? (function (d) {
                    const diff = Date.now() - d.getTime();
                    if (diff < 60_000) return "just now";
                    const mins = Math.floor(diff / 60000);
                    if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""} ago`;
                    const hours = Math.floor(mins / 60);
                    if (hours < 24) return `${hours} hr${hours > 1 ? "s" : ""} ago`;
                    const days = Math.floor(hours / 24);
                    return `${days} day${days > 1 ? "s" : ""} ago`;
                  })(lastSynced) : "Not synced"}
                </div>
              </div>
            </div>

            {/* Admin dropdown & Actions */}
            {isAdmin && (
              <div className="relative">
                <button
                  onClick={() => setShowAdminPanel((v) => !v)}
                  className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors ${showAdminPanel
                      ? "border-brand bg-brand/10 text-brand dark:text-steel"
                      : "border-line bg-shell text-muted hover:border-line/80 hover:text-ink dark:hover:text-white"
                    }`}
                >
                  <Shield size={14} />
                  <span>{tr("Admin Action", "ನಿರ್ವಾಹಕ ಕ್ರಿಯೆ")}</span>
                  {showAdminPanel ? <ChevronUp size={14} strokeWidth={2.5} /> : <ChevronDown size={14} strokeWidth={2.5} />}
                </button>

                {showAdminPanel && (
                  <div className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-line bg-shell p-3 shadow-soft">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted/60 pb-2 border-b border-line/30 mb-2 px-1">
                      {tr("Administrative Controls", "ಆಡಳಿತಾತ್ಮಕ ನಿಯಂತ್ರಣಗಳು")}
                    </p>
                    <button
                      onClick={() => {
                        void handleImport();
                        setShowAdminPanel(false);
                      }}
                      disabled={importing}
                      className="flex h-9 w-full items-center gap-2.5 rounded-lg border border-line bg-panel px-3 text-xs font-semibold text-ink transition-colors hover:border-brand/40 disabled:opacity-60"
                    >
                      <CloudDownload size={14} className="text-muted" />
                      <span>{importing ? tr("Importing...", "ಆಮದು ಮಾಡಲಾಗುತ್ತಿದೆ...") : tr("Import from Sheets", "ಶೀಟ್ಸ್ ನಿಂದ ಆಮದು")}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => setShowNewTaskModal(true)}
              className="flex h-9 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white transition hover:bg-brand/90"
            >
              <Plus size={15} strokeWidth={2.5} />
              <span>{tr("Add Task", "ಕಾರ್ಯ ಸೇರಿಸಿ")}</span>
            </button>
          </div>
        </div>

        {isDataLoading ? (
          <div className="grid place-items-center h-64 text-muted">
            <div className="flex flex-col items-center gap-3">
              <div className="w-10 h-10 rounded-full border-2 border-brand border-t-transparent animate-spin" />
              <span className="text-sm font-semibold tracking-wide">{tr("Loading intelligence data...", "ಬುದ್ಧಿಮತ್ತೆ ಡೇಟಾ ಲೋಡ್ ಆಗುತ್ತಿದೆ...")}</span>
            </div>
          </div>
        ) : (
          <>
            {/* ── Compact status strip ─────────────────────── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                { label: tr("Auto Tasks", "ಸ್ವಯಂ ಕಾರ್ಯಗಳು"), value: generatedStats.total, tone: "text-brand dark:text-steel" },
                { label: tr("Critical", "ನಿರ್ಣಾಯಕ"), value: generatedStats.critical, tone: generatedStats.critical ? "text-rose" : "text-ink dark:text-white" },
                { label: tr("High", "ಹೆಚ್ಚಿನ"), value: generatedStats.high, tone: generatedStats.high ? "text-amber" : "text-ink dark:text-white" },
                { label: tr("Overdue", "ಅವಧಿ ಮೀರಿದ"), value: generatedStats.overdue, tone: generatedStats.overdue ? "text-rose" : "text-ink dark:text-white" },
                { label: tr("This Week", "ಈ ವಾರ"), value: generatedStats.dueSoon, tone: "text-ink dark:text-white" },
                { label: tr("Court", "ನ್ಯಾಯಾಲಯ"), value: generatedStats.courtThisWeek, tone: "text-ink dark:text-white" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-line bg-shell p-4">
                  <div className="truncate text-[11px] uppercase tracking-wide text-muted">{stat.label}</div>
                  <div className={`mt-3 text-3xl font-semibold tabular-nums ${stat.tone}`}>{stat.value}</div>
                </div>
              ))}
            </div>

            {/* ── Tab Nav ─────────────────────────────────── */}
            <div className="rounded-xl border border-line bg-shell px-3">
              <div className="flex flex-wrap gap-5">
                {(["auto", "manual", "pinned", ...(isAdmin ? ["station"] : [])] as const).map((tab) => {
                  const isActive = activeTab === tab;
                  return (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab as any)}
                      className={`relative flex items-center gap-1.5 border-b-2 px-0.5 py-3 text-xs font-semibold transition-colors ${isActive
                          ? "border-brand text-brand dark:text-steel"
                          : "border-transparent text-muted hover:text-ink dark:hover:text-white"
                        }`}
                    >
                      {tab === "auto" && <Zap size={13} />}
                      {tab === "pinned" && <Pin size={13} />}
                      {tab === "manual" && <ClipboardList size={13} />}
                      {tab === "station" && <Activity size={13} />}

                      <span>
                        {tab === "auto" && tr("Auto Tasks", "ಸ್ವಯಂ ಕಾರ್ಯಗಳು")}
                        {tab === "pinned" && tr("Pinned", "ಪಿನ್ ಮಾಡಿದ")}
                        {tab === "manual" && tr("Manual", "ಹಸ್ತಚಾಲಿತ")}
                        {tab === "station" && tr("Station Operations", "ಠಾಣೆ ಕಾರ್ಯಾಚರಣೆ")}
                      </span>

                      {tab === "pinned" && (
                        <span className="ml-0.5 text-[10px] font-extrabold text-muted">
                          {pinnedTaskCount}
                        </span>
                      )}

                      {tab === "auto" && generatedStats.critical > 0 && (
                        <span className="ml-0.5 rounded-full bg-rose/10 px-1.5 py-0.5 text-[9px] font-extrabold text-rose">
                          {generatedStats.critical}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

            </div>

            {/* ═══════ TAB: AUTO TASKS ═══════ */}
            {activeTab === "auto" && (
              <div className="space-y-4">
                {activeGeneratedTasks.length === 0 ? (
                  <EmptyState
                    icon={<CheckCircle2 size={28} strokeWidth={2} />}
                    title={tr("No auto-tasks generated", "ಯಾವುದೇ ಸ್ವಯಂ ಕಾರ್ಯಗಳಿಲ್ಲ")}
                    description={tr(
                      "No FIRs are currently assigned to you, or all assigned FIRs are closed. Tasks will appear here automatically when cases are assigned.",
                      "ಯಾವುದೇ ಎಫ್‌ಐಆರ್‌ಗಳು ಈಗ ನಿಮಗೆ ನಿಯೋಜಿಸಲ್ಪಟ್ಟಿಲ್ಲ, ಅಥವಾ ಎಲ್ಲಾ ಪ್ರಕರಣಗಳು ಮುಚ್ಚಲಾಗಿದೆ."
                    )}
                  />
                ) : (
                  <div className="space-y-6 animate-in fade-in duration-200">
                    {groupedGeneratedTasks.map((group) => (
                      <section key={group.category} className="space-y-2.5" aria-labelledby={`task-group-${group.category}`}>
                        <div className="flex items-center justify-between px-1 mb-1 mt-4">
                          <div className="flex items-center gap-2.5">
                            <span className={`h-2 w-2 rounded-full ${group.dot}`} aria-hidden="true" />
                            <h2 id={`task-group-${group.category}`} className="text-xs font-semibold uppercase tracking-wide text-ink">
                              {tr(group.label, { "Chargesheet Deadlines": "ಆರೋಪಪಟ್ಟಿ ಗಡುವುಗಳು", "Court Appearances": "ನ್ಯಾಯಾಲಯ ಹಾಜರಾತಿಗಳು", "Stalled Investigations": "ಸ್ಥಗಿತಗೊಂಡ ತನಿಖೆಗಳು", "Active Investigations": "ಸಕ್ರಿಯ ತನಿಖೆಗಳು" }[group.label] || group.label)}
                            </h2>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-panel border border-line/30 text-muted">
                              {group.tasks.length} {group.tasks.length === 1 ? tr("task", "ಕಾರ್ಯ") : tr("tasks", "ಕಾರ್ಯಗಳು")}
                            </span>
                          </div>
                          <div className="h-[1px] flex-1 bg-gradient-to-r from-line/40 via-line/10 to-transparent ml-4 hidden sm:block" />
                        </div>

                        <div className="space-y-2">
                          {group.tasks.map((task) => (
                            <GeneratedTaskCard
                              key={task.id}
                              task={task}
                              today={today}
                              isPinned={isPinned(task.id)}
                              onTogglePinned={() => togglePinned(task.id)}
                              onComplete={() => setPendingAction({ kind: "complete-generated", task })}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══════ TAB: PINNED / MANUAL TASKS ═══════ */}
            {(activeTab === "pinned" || activeTab === "manual") && (
              <div className="space-y-4">
                {(activeTab === "pinned"
                  ? pinnedGeneratedTasks.length === 0 && pinnedManualTasks.length === 0
                  : visibleManualTasks.length === 0) ? (
                  <EmptyState
                    icon={activeTab === "pinned" ? <Pin size={28} /> : <ClipboardList size={28} />}
                    title={activeTab === "pinned" ? tr("No pinned tasks", "ಯಾವುದೇ ಪಿನ್ ಮಾಡಿದ ಕಾರ್ಯಗಳಿಲ್ಲ") : tr("No manual tasks", "ಯಾವುದೇ ಹಸ್ತಚಾಲಿತ ಕಾರ್ಯಗಳಿಲ್ಲ")}
                    description={
                      activeTab === "pinned"
                        ? tr(
                          "You haven't pinned any tasks yet. Click the pin icon on any task to bookmark it to your dashboard.",
                          "ನಿಮ್ಮ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ಗೆ ಬುಕ್‌ಮಾರ್ಕ್ ಮಾಡಲು ಯಾವುದೇ ಕಾರ್ಯದ ಮೇಲಿನ ಪಿನ್ ಐಕಾನ್ ಕ್ಲಿಕ್ ಮಾಡಿ."
                        )
                        : tr(
                          isAdmin
                            ? "Use the 'Add Task' button to create manual tasks or 'Admin Action' to import from Google Sheets."
                            : "No manual tasks created by your Inspector or imported from Sheets are currently active.",
                          isAdmin
                            ? "ಹಸ್ತಚಾಲಿತ ಕಾರ್ಯಗಳನ್ನು ರಚಿಸಲು 'ಕಾರ್ಯ ಸೇರಿಸಿ' ಬಟನ್ ಬಳಸಿ."
                            : "ನಿಮ್ಮ ಇನ್ಸ್ಪೆಕ್ಟರ್ ರಚಿಸಿದ ಯಾವುದೇ ಕಾರ್ಯಗಳು ಪ್ರಸ್ತುತ ಸಕ್ರಿಯವಾಗಿಲ್ಲ."
                        )
                    }
                  />
                ) : (
                  <div className="flex flex-col gap-6 animate-in fade-in duration-200">
                    {activeTab === "pinned" && pinnedGeneratedTasks.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 px-1 mb-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand dark:bg-steel" />
                          <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
                            {tr("Auto Tasks", "ಸ್ವಯಂ ಕಾರ್ಯಗಳು")}
                          </h2>
                        </div>
                        <div className="grid gap-3">
                          {pinnedGeneratedTasks.map((task) => (
                            <GeneratedTaskCard
                              key={task.id}
                              task={task}
                              today={today}
                              isPinned
                              onTogglePinned={() => togglePinned(task.id)}
                              onComplete={() => setPendingAction({ kind: "complete-generated", task })}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {activeTab === "pinned" && pinnedManualTasks.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 px-1 mb-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber" />
                          <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
                            {tr("Manual Tasks", "ಹಸ್ತಚಾಲಿತ ಕಾರ್ಯಗಳು")}
                          </h2>
                        </div>
                        <div className="grid gap-3">
                          {pinnedManualTasks.map((task) => (
                            <ManualTaskCard
                              key={task.taskId}
                              task={task}
                              isPinned={true}
                              isOverdue={overdueSet.has(task.taskId)}
                              isDueToday={dueTodaySet.has(task.taskId)}
                              isDueTomorrow={dueTomorrowSet.has(task.taskId)}
                              onComplete={() => setPendingAction({ kind: "complete-manual", task })}
                              onDelete={() => setPendingAction({ kind: "delete-manual", task })}
                              onTogglePinned={() => togglePinned(task.taskId)}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {activeTab === "manual" && visibleManualTasks.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 px-1 mb-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-muted" />
                          <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
                            {tr("Manual Tasks", "ಹಸ್ತಚಾಲಿತ ಕಾರ್ಯಗಳು")}
                          </h2>
                        </div>
                        <div className="grid gap-3">
                          {visibleManualTasks.map((task) => (
                            <ManualTaskCard
                              key={task.taskId}
                              task={task}
                              isPinned={isPinned(task.taskId)}
                              isOverdue={overdueSet.has(task.taskId)}
                              isDueToday={dueTodaySet.has(task.taskId)}
                              isDueTomorrow={dueTomorrowSet.has(task.taskId)}
                              onComplete={() => setPendingAction({ kind: "complete-manual", task })}
                              onDelete={() => setPendingAction({ kind: "delete-manual", task })}
                              onTogglePinned={() => togglePinned(task.taskId)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ═══════ TAB: STATION VIEW (Inspector/SP only) ═══════ */}
            {activeTab === "station" && persistedStats && (
              <div className="space-y-8 animate-in fade-in duration-200">
                <div className="flex items-center gap-3 border-b border-line/20 pb-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand/10 text-brand dark:text-steel">
                    <Activity size={18} strokeWidth={2.5} />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-ink dark:text-white tracking-tight">
                      {tr("Station Operations Analytics", "ಠಾಣೆ ಕಾರ್ಯಾಚರಣೆ ವಿಶ್ಲೇಷಣೆ")}
                    </h2>
                    <p className="text-xs text-muted dark:text-muted/70">
                      {tr("Real-time performance metrics and officer workload balancing.", "ನೈಜ-ಸಮಯದ ಪ್ರದರ್ಶನ ಮೆಟ್ರಿಕ್ಸ್ ಮತ್ತು ಕೆಲಸದ ಹಂಚಿಕೆ.")}
                    </p>
                  </div>
                </div>

                {/* Station Stats Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                  <StatTile
                    label={tr("Total Active", "ಒಟ್ಟು ಸಕ್ರಿಯ")}
                    value={persistedStats.activeTasks}
                    icon={<ClipboardList size={16} />}
                    colorTheme="blue"
                  />
                  <StatTile
                    label={tr("Critical", "ನಿರ್ಣಾಯಕ")}
                    value={persistedStats.criticalCount}
                    accent={persistedStats.criticalCount > 0 ? "text-rose" : "text-ink dark:text-white"}
                    icon={<AlertCircle size={16} />}
                    colorTheme={persistedStats.criticalCount > 0 ? "red" : "gray"}
                  />
                  <StatTile
                    label={tr("Overdue", "ಅವಧಿ ಮೀರಿದ")}
                    value={persistedStats.overdueCount}
                    accent={persistedStats.overdueCount > 0 ? "text-rose" : "text-ink dark:text-white"}
                    icon={<Clock size={16} />}
                    colorTheme={persistedStats.overdueCount > 0 ? "red" : "gray"}
                  />
                  <StatTile
                    label={tr("Due Today", "ಇಂದು ಗಡುವು")}
                    value={persistedStats.dueTodayCount}
                    accent={persistedStats.dueTodayCount > 0 ? "text-amber" : "text-ink dark:text-white"}
                    icon={<Calendar size={16} />}
                    colorTheme={persistedStats.dueTodayCount > 0 ? "amber" : "gray"}
                  />
                  <StatTile
                    label={tr("Completed Today", "ಇಂದು ಪೂರ್ಣ")}
                    value={persistedStats.completedTodayCount}
                    accent="text-sage"
                    icon={<CheckCircle2 size={16} />}
                    colorTheme="green"
                  />
                  <StatTile
                    label={tr("Completion %", "ಪೂರ್ಣಗೊಂಡ %")}
                    value={`${persistedStats.completionPct}%`}
                    accent="text-brand dark:text-steel"
                    icon={<Activity size={16} />}
                    colorTheme="blue"
                  />
                </div>

                {persistedStats.officerWorkload.length > 0 && (
                  <Card className="overflow-hidden border border-line/30 dark:border-line/40 shadow-soft">
                    <div className="px-6 py-4 border-b border-line/30 bg-panel/30 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-ink dark:text-white">{tr("Officer Workload Distribution", "ಅಧಿಕಾರಿ ಕೆಲಸದ ಹಂಚಿಕೆ")}</h3>
                        <p className="text-xs text-muted dark:text-muted/60 mt-0.5">{tr("Task allocations per active officer", "ಪ್ರತಿ ಅಧಿಕಾರಿಗಿರುವ ಕಾರ್ಯ ನಿಯೋಜನೆ")}</p>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="text-left text-[11px] text-muted dark:text-muted/80 uppercase tracking-wider bg-panel/10 border-b border-line/20">
                            <th className="px-6 py-3.5 font-bold">{tr("Officer Name", "ಅಧಿಕಾರಿ")}</th>
                            <th className="px-6 py-3.5 text-center font-bold">{tr("Active Tasks", "ಸಕ್ರಿಯ")}</th>
                            <th className="px-6 py-3.5 text-center font-bold">{tr("Overdue", "ಅವಧಿ ಮೀರಿದ")}</th>
                            <th className="px-6 py-3.5 text-center font-bold">{tr("Critical", "ನಿರ್ಣಾಯಕ")}</th>
                            <th className="px-6 py-3.5 font-bold">{tr("Workload Balance", "ಲೋಡ್")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line/20">
                          {persistedStats.officerWorkload.map((officer) => {
                            const maxTasks = Math.max(...persistedStats.officerWorkload.map((o) => o.total), 1);
                            const barPct = Math.round((officer.total / maxTasks) * 100);
                            return (
                              <tr key={officer.name} className="hover:bg-panel/20 transition-colors duration-150">
                                <td className="px-6 py-4">
                                  <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-brand/10 text-brand dark:text-steel flex items-center justify-center text-xs font-bold border border-brand/15">
                                      {getInitials(officer.name)}
                                    </div>
                                    <span className="font-semibold text-ink dark:text-white">{officer.name}</span>
                                  </div>
                                </td>
                                <td className="px-6 py-4 text-center tabular-nums font-semibold text-ink dark:text-white/90">{officer.total}</td>
                                <td className={`px-6 py-4 text-center tabular-nums font-bold ${officer.overdue > 0 ? "text-rose" : "text-muted"}`}>{officer.overdue}</td>
                                <td className={`px-6 py-4 text-center tabular-nums font-bold ${officer.critical > 0 ? "text-rose" : "text-muted"}`}>{officer.critical}</td>
                                <td className="px-6 py-4 w-48">
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-[10px] font-bold text-muted/80">
                                      <span>{barPct}%</span>
                                      <span>{officer.total} / {maxTasks} {tr("max", "ಗರಿಷ್ಠ")}</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-panel overflow-hidden border border-line/10">
                                      <div
                                        className={`h-full rounded-full transition-all duration-700 bg-gradient-to-r ${officer.overdue > 0
                                            ? "from-rose to-rose/80"
                                            : officer.critical > 0
                                              ? "from-amber to-amber/80"
                                              : "from-brand to-steel dark:from-brand dark:to-steel/80"
                                          }`}
                                        style={{ width: `${barPct}%` }}
                                      />
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
            )}
          </>
        )}

        {/* ═══════ NEW TASK MODAL ═══════ */}
        {showNewTaskModal && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="create-task-title">
            <Card className="w-full max-w-md overflow-hidden shadow-soft">
              {/* Modal Header */}
              <div className="flex items-start justify-between px-5 pb-3 pt-5">
                <div>
                  <h2 id="create-task-title" className="text-lg font-semibold text-ink">
                    {tr("Add a task", "ಕಾರ್ಯ ಸೇರಿಸಿ")}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted">{tr("A quick reminder for your active list.", "ನಿಮ್ಮ ಸಕ್ರಿಯ ಪಟ್ಟಿಗೆ ತ್ವರಿತ ಜ್ಞಾಪನೆ.")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewTaskModal(false)}
                  className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-ink"
                  aria-label={tr("Close dialog", "ಸಂವಾದ ಮುಚ್ಚಿ")}
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleCreate} className="space-y-3.5 px-5 pb-5">
                <div>
                  <label htmlFor="new-task-title" className="mb-1.5 block text-xs font-semibold text-ink">
                    {tr("What needs to be done?", "ಏನು ಮಾಡಬೇಕು?")} <span className="text-rose">*</span>
                  </label>
                  <input
                    id="new-task-title"
                    required
                    maxLength={160}
                    value={newTask.title}
                    onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                    autoFocus
                    className="h-10 w-full rounded-lg border border-line bg-panel px-3 text-sm text-ink outline-none placeholder:text-muted/50 focus:border-brand"
                    placeholder={tr("e.g. Verify witness signature", "ಉದಾ: ಸಾಕ್ಷಿ ಸಹಿ ಪರಿಶೀಲಿಸಿ")}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="new-task-priority" className="mb-1.5 block text-xs font-semibold text-ink">
                      {tr("Priority", "ಆದ್ಯತೆ")}
                    </label>
                    <select
                      id="new-task-priority"
                      value={newTask.priority}
                      onChange={(e) => setNewTask({ ...newTask, priority: e.target.value as any })}
                      className="h-10 w-full rounded-lg border border-line bg-panel px-3 text-sm text-ink outline-none focus:border-brand"
                    >
                      <option value="low">{tr("Low", "ಕಡಿಮೆ")}</option>
                      <option value="medium">{tr("Medium", "ಮಧ್ಯಮ")}</option>
                      <option value="high">{tr("High", "ಹೆಚ್ಚು")}</option>
                      <option value="critical">{tr("Critical", "ನಿರ್ಣಾಯಕ")}</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="new-task-due-date" className="mb-1.5 block text-xs font-semibold text-ink">
                      {tr("Due", "ಗಡುವು")}
                    </label>
                    <input
                      id="new-task-due-date"
                      type="date"
                      value={newTask.dueDate}
                      onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
                      className="h-10 w-full rounded-lg border border-line bg-panel px-3 text-sm text-ink outline-none focus:border-brand"
                    />
                  </div>
                </div>

                <details className="group rounded-lg border border-line bg-panel px-3 py-2.5">
                  <summary className="cursor-pointer list-none text-xs font-semibold text-muted transition-colors hover:text-ink">
                    <span className="inline-flex items-center gap-1.5">
                      <Plus size={13} /> {tr("Add notes (optional)", "ಟಿಪ್ಪಣಿಗಳನ್ನು ಸೇರಿಸಿ (ಐಚ್ಛಿಕ)")}
                    </span>
                  </summary>
                  <label htmlFor="new-task-description" className="sr-only">{tr("Description", "ವಿವರಣೆ")}</label>
                  <textarea
                    id="new-task-description"
                    maxLength={2000}
                    value={newTask.description}
                    onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                    className="mt-2 min-h-[82px] w-full resize-y rounded-lg border border-line bg-shell p-3 text-sm text-ink outline-none placeholder:text-muted/50 focus:border-brand"
                    placeholder={tr("Case context, contact number or note...", "ಪ್ರಕರಣದ ಸಂದರ್ಭ, ಸಂಪರ್ಕ ಸಂಖ್ಯೆ ಅಥವಾ ಟಿಪ್ಪಣಿ...")}
                  />
                </details>

                <div className="grid grid-cols-[0.8fr_1.2fr] gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowNewTaskModal(false)}
                    className="h-9 rounded-lg border border-line px-4 text-sm font-semibold text-muted transition-colors hover:bg-panel hover:text-ink"
                  >
                    {tr("Cancel", "ರದ್ದುಗೊಳಿಸಿ")}
                  </button>
                  <button
                    type="submit"
                    className="h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white transition-colors hover:bg-brand/90"
                  >
                    {tr("Add to my list", "ನನ್ನ ಪಟ್ಟಿಗೆ ಸೇರಿಸಿ")}
                  </button>
                </div>
              </form>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
};

export default TodoList;