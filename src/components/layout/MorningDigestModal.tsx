import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Link2,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import { KSPPBrandMark } from "../brand/KSPPBrand";
import { GeneratedTask, GeneratedTaskStats, localIsoDate } from "../../lib/taskEngine";
import { usePinnedTasks } from "../../lib/pinnedTasks";

export type MorningDigestModalProps = {
  officerName: string;
  employeeId: string;
  tasks: GeneratedTask[];
  stats: GeneratedTaskStats;
  isLoading?: boolean;
  onClose: () => void;
};

const priorityStyles: Record<GeneratedTask["priority"], string> = {
  critical: "border-rose/30 bg-rose/10 text-rose",
  high: "border-amber/30 bg-amber/10 text-amber",
  medium: "border-brand/30 bg-brand/10 text-brand",
  low: "border-line bg-panel text-muted",
};

function taskRank(task: GeneratedTask, today: Date) {
  const todayIso = localIsoDate(today);
  if (task.priority === "critical" || (task.dueDate && task.dueDate < todayIso)) return 0;
  if (task.dueDate === todayIso) return 1;
  return 2;
}

export const MorningDigestModal: React.FC<MorningDigestModalProps> = ({
  officerName,
  employeeId,
  tasks,
  stats,
  isLoading = false,
  onClose,
}) => {
  const navigate = useNavigate();
  const today = useMemo(() => new Date(), []);
  const { isPinned, togglePinned } = usePinnedTasks(employeeId);
  const orderedTasks = useMemo(
    () => [...tasks].sort((left, right) => taskRank(left, today) - taskRank(right, today)),
    [tasks, today],
  );
  const firstName = (officerName || "Officer").split(/\s+/)[0];
  const dateLabel = today.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const closeOnBackdrop = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 grid place-items-center overflow-y-auto px-3 py-5 sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="morning-digest-title"
      onMouseDown={closeOnBackdrop}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-line bg-shell shadow-soft">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
          <KSPPBrandMark size="md" decorative />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Daily task briefing · {dateLabel}</p>
            <h2 id="morning-digest-title" className="mt-1 text-lg font-semibold text-white">Good day, {firstName}</h2>
            <p className="mt-1 text-xs text-muted">Review priority work before you begin.</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-panel hover:text-white" aria-label="Close briefing"><X size={16} /></button>
        </header>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          {isLoading ? (
            <div className="grid min-h-40 place-items-center text-sm text-muted">Loading today&apos;s tasks...</div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                <SummaryTile icon={<ClipboardList size={14} />} label="Tasks" value={stats.total} />
                <SummaryTile icon={<AlertTriangle size={14} />} label="Urgent" value={stats.urgent} valueClass="text-rose" />
                <SummaryTile icon={<Calendar size={14} />} label="This week" value={stats.dueSoon} valueClass="text-brand" />
              </div>

              <section aria-labelledby="briefing-tasks-title">
                <div className="mb-2 flex items-center justify-between">
                  <h3 id="briefing-tasks-title" className="text-xs font-semibold uppercase tracking-wider text-muted">Today&apos;s tasks</h3>
                  <span className="text-[11px] text-muted">{orderedTasks.length} total</span>
                </div>
                {orderedTasks.length === 0 ? (
                  <div className="rounded-lg border border-line bg-panel p-4 text-center text-sm text-muted"><CheckCircle2 className="mx-auto mb-2 text-brand" size={20} />No tasks require attention today.</div>
                ) : (
                  <div className="space-y-2">
                    {orderedTasks.map((task) => (
                      <div key={task.id} className={`flex items-start gap-3 rounded-lg border p-3 ${priorityStyles[task.priority]}`}>
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-white">{task.title}</p><span className="text-[10px] font-bold uppercase tracking-wider">{task.priority}</span></div>
                          <p className="mt-1 text-xs text-muted">{task.dueContext}</p>
                          <p className="mt-1 flex items-center gap-1 text-[10px] text-muted"><Link2 size={11} /> FIR {task.displayFirNumber}</p>
                        </div>
                        <button type="button" onClick={() => togglePinned(task.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-muted hover:bg-panel hover:text-brand" aria-label={isPinned(task.id) ? `Unpin ${task.title}` : `Pin ${task.title}`} title={isPinned(task.id) ? "Unpin task" : "Pin task"}>{isPinned(task.id) ? <PinOff size={15} /> : <Pin size={15} />}</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

            </>
          )}
        </div>

        <footer className="flex gap-2 border-t border-line px-5 py-4 sm:px-6">
          <button type="button" onClick={() => { onClose(); navigate("/todo"); }} disabled={isLoading} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50">View full task list <ArrowRight size={15} /></button>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2.5 text-sm font-semibold text-muted hover:bg-panel hover:text-white">Close</button>
        </footer>
      </div>
    </div>
  );
};

const SummaryTile: React.FC<{ icon: React.ReactNode; label: string; value: number; valueClass?: string }> = ({ icon, label, value, valueClass = "text-white" }) => (
  <div className="rounded-lg border border-line bg-panel p-3"><div className="flex items-center gap-2 text-muted">{icon}<span className="text-[10px] font-semibold uppercase">{label}</span></div><strong className={`mt-1 block text-xl ${valueClass}`}>{value}</strong></div>
);
