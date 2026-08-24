import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import {
  ClipboardList, AlertCircle, Clock, Calendar, AlertTriangle,
  CheckCircle2, CloudDownload, Plus, Building2, Activity, Trash2, RefreshCw,
  ChevronDown, ChevronUp, Zap, Shield,
  Link2, Pin, Check, X
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
    className={`bg-shell border border-line/30 dark:border-line/40 rounded-2xl shadow-soft transition-all duration-200 ${
      onClick ? "cursor-pointer hover:border-brand/40 dark:hover:border-steel/40 hover:shadow-md active:scale-[0.995]" : ""
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
  const themeMap = {
    blue: "from-brand/10 to-brand/0 border-brand/25 text-brand dark:text-sky-200",
    red: "from-rose/10 to-rose/0 border-rose/25 text-rose-700 dark:text-rose-200",
    amber: "from-amber/10 to-amber/0 border-amber/25 text-amber-700 dark:text-amber-200",
    green: "from-sage/10 to-sage/0 border-sage/25 text-emerald-700 dark:text-emerald-200",
    gray: "from-slate-200/80 to-slate-100/0 border-slate-300 text-slate-700 dark:text-slate-200",
  };

  return (
    <div className="relative overflow-hidden flex flex-col justify-between p-5 bg-white/90 dark:bg-panel/80 border border-slate-200/80 dark:border-line/40 rounded-2xl shadow-soft transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 hover:border-slate-300 dark:hover:border-line/85 group">
      {/* Decorative top border glow */}
      <div className={`absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r ${
        colorTheme === "blue" ? "from-brand to-steel" : 
        colorTheme === "red" ? "from-rose to-red-400" : 
        colorTheme === "amber" ? "from-amber to-yellow-500" : 
        colorTheme === "green" ? "from-sage to-emerald-400" : "from-slate-400 to-slate-500"
      }`} />
      
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 w-full">
          <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 tracking-wider uppercase font-sans">
            {label}
          </span>
          <span className={`text-3xl font-extrabold font-fustat tabular-nums leading-none tracking-tight mt-1.5 ${accent}`}>
            {value}
          </span>
        </div>
      </div>

      {sub && (
        <div className="mt-3 text-[10px] text-slate-500 dark:text-slate-400 border-t border-slate-200/80 dark:border-line/10 pt-2 flex items-center justify-between">
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
        <span>{expanded ? "Show Less" : "Show More"}</span>
        {expanded ? <ChevronUp size={12} strokeWidth={2.5} /> : <ChevronDown size={12} strokeWidth={2.5} />}
      </button>
    </div>
  );
};

// ─── Priority Badges ──────────────────────────────────────────────────────────

const PriorityBadge: React.FC<{ priority: TaskPriority }> = ({ priority }) => {
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
      {priority}
    </span>
  );
};

const formatTaskTitle = (task: GeneratedTask) => {
  const action = task.title.replace(/\s+[—-]\s*FIR\s+.*$/i, "").trim();
  return `${action} — FIR ${task.linkedFirNumber}`;
};

// ─── Generated Task Card ──────────────────────────────────────────────────────

const GeneratedTaskCard: React.FC<{
  task: GeneratedTask;
  today: Date;
  isPinned: boolean;
  onTogglePinned: () => void;
  onComplete: () => void;
}> = ({ task, today, isPinned, onTogglePinned, onComplete }) => {
  const navigate = useNavigate();
  const [isCompleting, setIsCompleting] = useState(false);
  const todayIso = today.toLocaleDateString("sv");
  const isOverdue = task.dueDate ? task.dueDate < todayIso : false;
  const openCase = () => navigate(`/fir/${encodeURIComponent(task.linkedFirNumber)}`);

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={openCase}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCase();
        }
      }}
      className="cursor-pointer group block focus:outline-none"
    >
      <Card
        className={`p-4 sm:p-5 flex flex-col sm:flex-row gap-4 sm:items-center border-l-4 transition-all duration-300 hover:shadow-md ${
          task.priority === "critical"
            ? "border-l-rose bg-rose/[0.02] dark:bg-rose/[0.01] hover:bg-rose/[0.04]"
            : task.priority === "high"
            ? "border-l-amber bg-amber/[0.01] hover:bg-amber/[0.03]"
            : task.priority === "medium"
            ? "border-l-brand bg-transparent hover:bg-panel/30"
            : isOverdue
            ? "border-l-rose bg-rose/[0.02] dark:bg-rose/[0.01]"
            : "border-l-line bg-transparent hover:bg-panel/30"
        }`}
      >
        <div className="flex-1 min-w-0 flex items-start gap-3">
          <button
            type="button"
            role="checkbox"
            aria-checked={isCompleting}
            onClick={(event) => {
              event.stopPropagation();
              if (isCompleting) return;
              if (window.confirm(`Mark "${formatTaskTitle(task)}" as complete?`)) {
                setIsCompleting(true);
                onComplete();
              }
            }}
            className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-lg border-2 transition-all duration-200 ${
              isCompleting
                ? "border-2 border-brand bg-brand text-white scale-95 shadow-sm shadow-brand/20"
                : "border-slate-400 bg-white text-transparent hover:border-brand hover:bg-brand/5 hover:text-brand/40 dark:border-slate-500 dark:bg-panel"
            }`}
            aria-label={`Complete ${formatTaskTitle(task)}`}
          >
            <Check size={12} strokeWidth={3} className={isCompleting ? "scale-100" : "scale-75 opacity-0 hover:opacity-100 hover:scale-100 transition-all duration-200"} />
          </button>

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-[15px] font-bold tracking-tight text-ink dark:text-white group-hover:text-brand dark:group-hover:text-steel transition-colors duration-200">
                {formatTaskTitle(task)}
              </h3>
              <div className="flex items-center gap-1.5 flex-wrap">
                <PriorityBadge priority={task.priority} />
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-[10px] font-medium text-slate-700 transition-colors group-hover:border-slate-400 dark:border-line dark:bg-panel/80 dark:text-slate-200">
                  <Link2 size={10} strokeWidth={2.5} className="text-slate-600 dark:text-muted/60" />
                  FIR {task.linkedFirNumber}
                </span>
                {isOverdue && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:border-rose/25 dark:bg-rose/10 dark:text-rose">
                    <Clock size={10} className="animate-pulse" />
                    Overdue
                  </span>
                )}
              </div>
            </div>

            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300 font-medium">
              {task.dueContext}
            </p>
          </div>
        </div>

        {/* Pin and Action Panel */}
        <div className="flex shrink-0 items-center justify-end gap-2 self-end sm:self-center border-t border-line/10 sm:border-none pt-3 sm:pt-0">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTogglePinned();
            }}
            className={`grid h-9 w-9 place-items-center rounded-xl border transition-all duration-200 ${
              isPinned
                ? "border-amber/30 bg-amber/10 text-amber shadow-sm shadow-amber/10"
                : "border-line bg-panel text-muted hover:border-amber/30 hover:bg-amber/5 hover:text-amber"
            }`}
            aria-label={isPinned ? `Unpin ${task.title}` : `Pin ${task.title}`}
            title={isPinned ? "Unpin task" : "Pin task"}
          >
            <Pin size={14} fill={isPinned ? "currentColor" : "none"} className={isPinned ? "rotate-45 transition-transform" : "transition-transform"} />
          </button>
          
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openCase();
            }}
            className="hidden sm:grid h-9 w-9 place-items-center rounded-xl border border-line bg-panel text-muted hover:border-brand/40 hover:bg-brand/5 hover:text-brand transition-all duration-200"
            title="View Case Details"
          >
            <Activity size={14} />
          </button>
        </div>
      </Card>
    </div>
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
  const [isCompleting, setIsCompleting] = useState(false);
  const addedAtLabel = task.source === "manual" && task.createdAt
    ? `Added ${new Date(task.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
    : "";

  return (
    <Card
      className={`p-4 sm:p-5 flex flex-col sm:flex-row gap-4 sm:items-center border-l-4 transition-all duration-300 hover:shadow-md ${
        task.status === "completed"
          ? "opacity-60 bg-panel/30 border-l-line"
          : task.priority === "critical"
          ? "border-l-rose bg-rose/[0.01] hover:bg-rose/[0.03]"
          : task.priority === "high"
          ? "border-l-amber bg-amber/[0.01] hover:bg-amber/[0.03]"
          : isOverdue
          ? "border-l-rose bg-rose/[0.01]"
          : "border-l-line bg-transparent hover:bg-panel/30"
      }`}
    >
      <div className="flex-1 min-w-0 flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={isCompleting || task.status === "completed"}
          onClick={(event) => {
            event.stopPropagation();
            if (isCompleting || task.status === "completed") return;
            if (window.confirm(`Mark "${task.title}" as complete?`)) {
              setIsCompleting(true);
              onComplete();
            }
          }}
          className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-lg border-2 transition-all duration-200 ${
            task.status === "completed" || isCompleting
              ? "border-2 border-brand bg-brand text-white scale-95 shadow-sm shadow-brand/20"
              : "border-slate-400 bg-white text-transparent hover:border-brand hover:bg-brand/5 hover:text-brand/40 dark:border-slate-500 dark:bg-panel"
          }`}
          aria-label={`Complete ${task.title}`}
        >
          <Check size={12} strokeWidth={3} className={(isCompleting || task.status === "completed") ? "scale-100" : "scale-75 opacity-0 hover:opacity-100 hover:scale-100 transition-all duration-200"} />
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-[15px] font-bold tracking-tight ${
              task.status === "completed" ? "line-through text-muted" : "text-ink dark:text-white"
            }`}>
              {task.title}
            </h3>
            
            <div className="flex items-center gap-1.5 flex-wrap">
              <PriorityBadge priority={task.priority} />
              
              {task.source === "google_sheets" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  Imported
                </span>
              )}
              
              {isOverdue && task.status !== "completed" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-700 dark:border-rose/25 dark:bg-rose/10 dark:text-rose">
                  <Clock size={10} className="animate-pulse" />
                  Overdue
                </span>
              )}
              
              {isDueToday && task.status !== "completed" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:border-amber/25 dark:bg-amber/10 dark:text-amber-200">
                  Due Today
                </span>
              )}
              
              {isDueTomorrow && task.status !== "completed" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/5 dark:text-steel">
                  Due Tomorrow
                </span>
              )}
            </div>
          </div>

          <TaskDescription text={task.description} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 text-xs font-semibold text-muted dark:text-muted/80">
            {task.dueDate && (
              <span className={`flex items-center gap-1.5 ${isOverdue ? "text-rose font-bold" : (isDueToday || isDueTomorrow) ? "text-amber font-bold" : ""}`}>
                <Calendar size={13} strokeWidth={2.5} />
                {new Date(task.dueDate).toLocaleDateString()}
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

      <div className="flex shrink-0 flex-col items-end gap-2 self-end sm:self-center border-t border-line/10 sm:border-none pt-3 sm:pt-0">
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
            className="grid h-9 w-9 place-items-center rounded-xl border border-line bg-panel text-muted hover:border-rose/30 hover:bg-rose/10 hover:text-rose transition-all duration-200"
            aria-label={`Delete ${task.title}`}
            title="Delete task"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            onClick={onTogglePinned}
            className={`grid h-9 w-9 place-items-center rounded-xl border transition-all duration-200 ${
              isPinned
                ? "border-amber/30 bg-amber/10 text-amber shadow-sm shadow-amber/10"
                : "border-line bg-panel text-muted hover:border-amber/30 hover:bg-amber/5 hover:text-amber"
            }`}
            aria-label={isPinned ? `Unpin ${task.title}` : `Pin ${task.title}`}
            title={isPinned ? "Unpin task" : "Pin task"}
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
  <Card className="flex flex-col items-center justify-center py-20 px-6 text-center border border-dashed border-line/60 bg-panel/20 dark:bg-panel/10 rounded-2xl">
    <div className="h-16 w-16 mb-5 rounded-2xl bg-panel border border-line/40 text-brand dark:text-steel flex items-center justify-center shadow-inner">
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
  const { tr } = useLanguage();
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

  // ── Persisted / manual tasks (legacy — read from TodoTasks sheet) ──
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
  const [activeTab, setActiveTab] = useState<"auto" | "manual" | "pinned" | "station">( "auto" );
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  // ── New Task Modal ──
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [newTask, setNewTask] = useState<Partial<TodoTask>>({
    title: "",
    description: "",
    priority: "medium",
    dueDate: "",
  });
  const [pendingDeleteTask, setPendingDeleteTask] = useState<TodoTask | null>(null);

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
    try {
      setPersistedTasks(
        persistedTasks.map((t) =>
          t.taskId === task.taskId ? { ...t, status: newStatus as any } : t
        )
      );
      await updateTodo(task.taskId, { status: newStatus as any });
      void fetchStats()
        .then((s) => { if (s.ok) setPersistedStats(s.stats); })
        .catch(() => undefined);
    } catch (err: any) {
      setPersistedTasks(persistedTasks);
      setError(err.message || "Failed to update task");
    }
  };

  const handleDelete = async (task: TodoTask) => {
    if (!task?.taskId) {
      setPendingDeleteTask(null);
      return;
    }

    const taskId = task.taskId;
    const employeeId = user?.employeeId;

    // Close the confirmation UI immediately
    setPendingDeleteTask(null);
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await createTodo({
        ...newTask,
        assignedTo: user?.employeeId,
      });
      if (created.ok) {
        setPersistedTasks([created.todo, ...persistedTasks]);
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
      {pendingDeleteTask && (
        <div className="modal-backdrop fixed inset-0 z-[70] grid place-items-center px-4" role="dialog" aria-modal="true" aria-labelledby="delete-task-title">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-300/80 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)] dark:border-line/60 dark:bg-shell dark:shadow-gov">
            <div className="flex items-start gap-3 border-b border-slate-200 bg-slate-100/80 px-5 py-4 dark:border-line/60 dark:bg-panel/80">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-rose-200 bg-rose-50 text-rose-600 dark:border-rose/20 dark:bg-rose/10 dark:text-rose">
                <Trash2 size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="delete-task-title" className="text-lg font-bold text-slate-800 tracking-tight dark:text-white">
                  Delete task
                </h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-muted/80">
                  Are u sure u wanna delete?
                </p>
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium break-words text-slate-800 dark:border-line/60 dark:bg-panel/60 dark:text-white">
                {pendingDeleteTask.title}
              </div>
              <div className="mt-5 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setPendingDeleteTask(null)}
                  className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:text-slate-900 dark:border-line dark:bg-panel dark:text-muted dark:hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(pendingDeleteTask)}
                  className="rounded-xl border border-rose-300 bg-rose-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-rose-500 dark:border-rose/30 dark:bg-rose dark:hover:bg-rose/90"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">

      {/* ── Dashboard Header ─────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-6 border-b border-line/20 mb-4">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand/10 text-brand dark:text-steel text-[10px] font-bold uppercase tracking-wider border border-brand/25 dark:border-steel/20">
            <Shield size={11} className="animate-pulse" />
            {tr("Officer Command Centre", "ಅಧಿಕಾರಿ ಕಮಾಂಡ್ ಸೆಂಟರ್")}
          </div>
          <h1 className="text-3xl font-extrabold font-fustat text-ink dark:text-white tracking-tight leading-none">
            {tr("Officer To-Do List", "ಅಧಿಕಾರಿಗಳ ಕಾರ್ಯಗಳ ಪಟ್ಟಿ")}
          </h1>
          <p className="text-sm font-medium text-muted dark:text-muted/80 max-w-2xl leading-relaxed">
            {tr(
              "Intelligence-driven tasks derived automatically from your active and assigned FIRs — synchronized with core case databases.",
              "ನಿಮ್ಮ ಸಕ್ರಿಯ ಮತ್ತು ನಿಯೋಜಿತ ಎಫ್‌ಐಆರ್‌ಗಳಿಂದ ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಪಡೆದ ಬುದ್ಧಿಮತ್ತೆ ಆಧಾರಿತ ಕಾರ್ಯಗಳು."
            )}
          </p>
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-rose/10 border border-rose/25 text-xs text-rose font-semibold max-w-md animate-in fade-in duration-200">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 self-start md:self-center shrink-0">
          {/* Sync control: manual refresh + last-synced */}
          <div className="flex items-center gap-3 mr-2">
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${syncing ? "opacity-70 cursor-wait" : "hover:bg-slate-100 dark:hover:bg-panel/70"} bg-slate-50 dark:bg-panel border-slate-200/80 dark:border-line/60`}
            >
              <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
              <span>Sync Latest</span>
            </button>
            <div className="text-xs text-muted">
              <div title={lastSynced ? lastSynced.toLocaleString() : "Never"}>
                {"Last synced: "}{lastSynced ? (function(d){
                  const diff = Date.now() - d.getTime();
                  if (diff < 60_000) return "just now";
                  const mins = Math.floor(diff/60000);
                  if (mins < 60) return `${mins} min${mins>1?"s":""} ago`;
                  const hours = Math.floor(mins/60);
                  if (hours < 24) return `${hours} hr${hours>1?"s":""} ago`;
                  const days = Math.floor(hours/24);
                  return `${days} day${days>1?"s":""} ago`;
                })(lastSynced) : "Never"}
              </div>
            </div>
          </div>

          {/* Admin dropdown & Actions */}
          {isAdmin && (
            <div className="relative">
              <button
                onClick={() => setShowAdminPanel((v) => !v)}
                className={`flex h-11 items-center gap-2 rounded-xl border px-4 text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
                  showAdminPanel 
                    ? "border-brand bg-brand/10 text-brand dark:text-steel" 
                    : "border-line bg-shell text-muted hover:border-line/80 hover:text-ink dark:hover:text-white"
                }`}
              >
                <Shield size={14} />
                <span>{tr("Admin Action", "ನಿರ್ವಾಹಕ ಕ್ರಿಯೆ")}</span>
                {showAdminPanel ? <ChevronUp size={14} strokeWidth={2.5} /> : <ChevronDown size={14} strokeWidth={2.5} />}
              </button>
              
              {showAdminPanel && (
                <div className="absolute right-0 mt-2 z-30 w-64 p-3 bg-panel border border-line/60 rounded-2xl shadow-gov animate-in fade-in slide-in-from-top-2 duration-200">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted/60 pb-2 border-b border-line/30 mb-2 px-1">
                    {tr("Administrative Controls", "ಆಡಳಿತಾತ್ಮಕ ನಿಯಂತ್ರಣಗಳು")}
                  </p>
                  <button
                    onClick={() => {
                      void handleImport();
                      setShowAdminPanel(false);
                    }}
                    disabled={importing}
                    className="w-full flex h-10 items-center gap-2.5 rounded-xl border border-line/60 bg-shell px-3 text-xs font-bold text-ink dark:text-white/90 hover:bg-panel/60 hover:border-line active:scale-[0.98] disabled:opacity-60 transition-all duration-150"
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
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-brand hover:bg-brand/95 px-5 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-brand/20 active:scale-[0.98] transition-all duration-200"
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
          {/* ── Stat Tiles ──────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatTile
              label={tr("Auto Tasks", "ಸ್ವಯಂ ಕಾರ್ಯಗಳು")}
              value={generatedStats.total}
              accent="text-brand dark:text-steel"
              icon={<ClipboardList size={16} />}
              colorTheme="blue"
            />
            <StatTile
              label={tr("Critical", "ನಿರ್ಣಾಯಕ")}
              value={generatedStats.critical}
              accent={generatedStats.critical > 0 ? "text-rose" : "text-ink dark:text-white"}
              icon={<AlertTriangle size={16} />}
              colorTheme={generatedStats.critical > 0 ? "red" : "gray"}
            />
            <StatTile
              label={tr("High Priority", "ಹೆಚ್ಚಿನ ಆದ್ಯತೆ")}
              value={generatedStats.high}
              accent={generatedStats.high > 0 ? "text-amber" : "text-ink dark:text-white"}
              icon={<Activity size={16} />}
              colorTheme={generatedStats.high > 0 ? "amber" : "gray"}
            />
            <StatTile
              label={tr("Overdue", "ಅವಧಿ ಮೀರಿದ")}
              value={generatedStats.overdue}
              accent={generatedStats.overdue > 0 ? "text-rose" : "text-ink dark:text-white"}
              icon={<Clock size={16} />}
              colorTheme={generatedStats.overdue > 0 ? "red" : "gray"}
            />
            <StatTile
              label={tr("Due This Week", "ಈ ವಾರ ಗಡುವು")}
              value={generatedStats.dueSoon}
              icon={<Calendar size={16} />}
              colorTheme="blue"
            />
            <StatTile
              label={tr("Court This Week", "ಈ ವಾರ ನ್ಯಾಯಾಲಯ")}
              value={generatedStats.courtThisWeek}
              accent={generatedStats.courtThisWeek > 0 ? "text-brand dark:text-steel" : "text-ink dark:text-white"}
              icon={<Building2 size={16} />}
              colorTheme={generatedStats.courtThisWeek > 0 ? "blue" : "gray"}
            />
          </div>

          {/* ── Tab Nav ─────────────────────────────────── */}
          <div className="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-slate-300/80 bg-slate-200/80 p-1.5 shadow-sm dark:border-line/30 dark:bg-panel/30 dark:shadow-none">
            <div className="flex flex-wrap gap-1">
              {(["auto", "manual", "pinned", ...(isAdmin ? ["station"] : [])] as const).map((tab) => {
                const isActive = activeTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab as any)}
                    className={`relative flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
                      isActive
                        ? "bg-brand text-white shadow-lg shadow-brand/20 dark:shadow-none"
                        : "text-slate-900 hover:text-slate-950 dark:text-muted/80 dark:hover:text-white hover:bg-slate-100/80 dark:hover:bg-panel/60"
                    }`}
                  >
                    {tab === "auto" && <Zap size={14} className={isActive ? "text-white" : "text-brand dark:text-steel"} />}
                    {tab === "pinned" && <Pin size={14} className={isActive ? "text-white" : "text-amber"} />}
                    {tab === "manual" && <ClipboardList size={14} className={isActive ? "text-white" : "text-slate-900 dark:text-muted"} />}
                    {tab === "station" && <Activity size={14} className={isActive ? "text-white" : "text-sage"} />}

                    <span>
                      {tab === "auto" && tr("Auto Tasks", "ಸ್ವಯಂ ಕಾರ್ಯಗಳು")}
                      {tab === "pinned" && tr("Pinned", "ಪಿನ್ ಮಾಡಿದ")}
                      {tab === "manual" && tr("Manual", "ಹಸ್ತಚಾಲಿತ")}
                      {tab === "station" && tr("Station Operations", "ಠಾಣೆ ಕಾರ್ಯಾಚರಣೆ")}
                    </span>

                    {tab === "pinned" && (
                      <span className="ml-1 flex h-4.5 min-w-[18px] items-center justify-center rounded-full border border-slate-300 bg-white px-1 text-[9px] font-extrabold text-slate-900">
                        {pinnedTaskCount}
                      </span>
                    )}

                    {tab === "auto" && generatedStats.critical > 0 && (
                      <span className={`ml-1 flex h-4.5 min-w-[18px] items-center justify-center rounded-full px-1 text-[9px] font-extrabold ${
                        isActive ? "bg-white text-brand" : "bg-rose text-white animate-pulse"
                      }`}>
                        {generatedStats.critical}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="hidden items-center gap-2 rounded-xl border border-slate-300 bg-white/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-700 lg:flex dark:border-line/30 dark:bg-panel dark:text-muted/80">
              <span className="h-1.5 w-1.5 rounded-full bg-sage animate-ping" />
              <span>{tr("Synced Live", "ಲೈವ್ ಸಿಂಕ್ ಮಾಡಲಾಗಿದೆ")}</span>
            </div>
          </div>

          {/* ═══════ TAB: AUTO TASKS ═══════ */}
          {activeTab === "auto" && (
            <div className="space-y-4">
              {generatedTasks.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 size={28} strokeWidth={2} />}
                  title={tr("No auto-tasks generated", "ಯಾವುದೇ ಸ್ವಯಂ ಕಾರ್ಯಗಳಿಲ್ಲ")}
                  description={tr(
                    "No FIRs are currently assigned to you, or all assigned FIRs are closed. Tasks will appear here automatically when cases are assigned.",
                    "ಯಾವುದೇ ಎಫ್‌ಐಆರ್‌ಗಳು ಈಗ ನಿಮಗೆ ನಿಯೋಜಿಸಲ್ಪಟ್ಟಿಲ್ಲ, ಅಥವಾ ಎಲ್ಲಾ ಪ್ರಕರಣಗಳು ಮುಚ್ಚಲಾಗಿದೆ."
                  )}
                />
              ) : (
                <div className="space-y-8 animate-in fade-in duration-200">
                  {groupedGeneratedTasks.map((group) => (
                    <section key={group.category} className="space-y-3.5" aria-labelledby={`task-group-${group.category}`}>
                      <div className="flex items-center justify-between px-1 mb-1 mt-4">
                        <div className="flex items-center gap-2.5">
                          <span className={`h-2.5 w-2.5 rounded-full ${group.dot} animate-pulse`} aria-hidden="true" />
                          <h2 id={`task-group-${group.category}`} className="text-xs font-bold uppercase tracking-wider text-ink dark:text-white/90">
                            {tr(group.label, group.label)}
                          </h2>
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-panel border border-line/30 text-muted">
                            {group.tasks.length} {group.tasks.length === 1 ? tr("task", "ಕಾರ್ಯ") : tr("tasks", "ಕಾರ್ಯಗಳು")}
                          </span>
                        </div>
                        <div className="h-[1px] flex-1 bg-gradient-to-r from-line/40 via-line/10 to-transparent ml-4 hidden sm:block" />
                      </div>
                      
                      <div className="space-y-3">
                        {group.tasks.map((task) => (
                          <GeneratedTaskCard
                            key={task.id}
                            task={task}
                            today={today}
                            isPinned={isPinned(task.id)}
                            onTogglePinned={() => togglePinned(task.id)}
                            onComplete={() => markCompleted(task.id)}
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
                            onComplete={() => markCompleted(task.id)}
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
                            onComplete={() => void handleStatusChange(task, "completed")}
                            onDelete={() => setPendingDeleteTask(task)}
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
                            onComplete={() => void handleStatusChange(task, "completed")}
                            onDelete={() => setPendingDeleteTask(task)}
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
                                    <span>{officer.total} / {maxTasks} max</span>
                                  </div>
                                  <div className="h-2 rounded-full bg-panel overflow-hidden border border-line/10">
                                    <div
                                      className={`h-full rounded-full transition-all duration-700 bg-gradient-to-r ${
                                        officer.overdue > 0 
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
        <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-md transition-all duration-300">
          <Card className="w-full max-w-lg shadow-2xl border border-line/60 bg-shell overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-line/40 px-6 py-4 bg-panel/30">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 text-brand dark:text-steel">
                  <Plus size={16} strokeWidth={2.5} />
                </span>
                <h2 className="text-base font-bold text-ink dark:text-white tracking-tight">
                  {tr("Create New Task", "ಹೊಸ ಕಾರ್ಯ ರಚಿಸಿ")}
                </h2>
              </div>
              <button 
                onClick={() => setShowNewTaskModal(false)} 
                className="grid h-7 w-7 place-items-center rounded-lg hover:bg-panel text-muted hover:text-ink dark:hover:text-white transition-colors"
                aria-label="Close dialog"
              >
                <X size={16} />
              </button>
            </div>
            
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-muted dark:text-muted/80 mb-1.5">
                  {tr("Task Title", "ಕಾರ್ಯದ ಶೀರ್ಷಿಕೆ")} <span className="text-rose">*</span>
                </label>
                <input
                  required
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                  className="w-full h-11 px-3.5 bg-panel border border-line/50 rounded-xl text-sm text-ink dark:text-white placeholder-muted/50 focus:border-brand dark:focus:border-steel focus:ring-1 focus:ring-brand outline-none transition-all duration-200 shadow-inner"
                  placeholder={tr("e.g. Verify witness signature", "ಉದಾ: ಸಾಕ್ಷಿ ಸಹಿ ಪರಿಶೀಲಿಸಿ")}
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-muted dark:text-muted/80 mb-1.5">
                  {tr("Description", "ವಿವರಣೆ")}
                </label>
                <textarea
                  value={newTask.description}
                  onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                  className="w-full p-3.5 bg-panel border border-line/50 rounded-xl text-sm text-ink dark:text-white placeholder-muted/50 focus:border-brand dark:focus:border-steel focus:ring-1 focus:ring-brand outline-none resize-y min-h-[110px] transition-all duration-200 shadow-inner"
                  placeholder={tr("Provide case context, contact numbers or notes...", "ಪ್ರಕರಣದ ಸಂದರ್ಭ, ಸಂಪರ್ಕ ಸಂಖ್ಯೆಗಳು ಅಥವಾ ಟಿಪ್ಪಣಿಗಳನ್ನು ಒದಗಿಸಿ...")}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-muted dark:text-muted/80 mb-1.5">
                    {tr("Priority Level", "ಆದ್ಯತೆ")}
                  </label>
                  <select
                    value={newTask.priority}
                    onChange={(e) => setNewTask({ ...newTask, priority: e.target.value as any })}
                    className="w-full h-11 px-3.5 bg-panel border border-line/50 rounded-xl text-sm text-ink dark:text-white focus:border-brand focus:ring-1 focus:ring-brand outline-none transition-all duration-200"
                  >
                    <option value="low">{tr("Low", "ಕಡಿಮೆ")}</option>
                    <option value="medium">{tr("Medium", "ಮಧ್ಯಮ")}</option>
                    <option value="high">{tr("High", "ಹೆಚ್ಚು")}</option>
                    <option value="critical">{tr("Critical", "ನಿರ್ಣಾಯಕ")}</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-muted dark:text-muted/80 mb-1.5">
                    {tr("Due Date", "ಗಡುವು ದಿನಾಂಕ")}
                  </label>
                  <input
                    type="date"
                    value={newTask.dueDate}
                    onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
                    className="w-full h-11 px-3.5 bg-panel border border-line/50 rounded-xl text-sm text-ink dark:text-white focus:border-brand focus:ring-1 focus:ring-brand outline-none transition-all duration-200"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-line/30 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowNewTaskModal(false)}
                  className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-muted dark:text-muted hover:text-ink dark:hover:text-white border border-line rounded-xl hover:bg-panel transition-all duration-200"
                >
                  {tr("Cancel", "ರದ್ದುಗೊಳಿಸಿ")}
                </button>
                <button
                  type="submit"
                  className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-brand rounded-xl shadow-lg shadow-brand/20 hover:bg-brand/90 active:scale-[0.98] transition-all duration-200"
                >
                  {tr("Create Task", "ಕಾರ್ಯವನ್ನು ರಚಿಸಿ")}
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
