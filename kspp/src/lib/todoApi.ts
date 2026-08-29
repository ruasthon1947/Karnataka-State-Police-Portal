export interface TodoTask {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "pending" | "in_progress" | "completed";
  dueDate?: string;
  policeStation?: string;
  assignedTo?: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TodoStats {
  totalTasks: number;
  completedTasks: number;
  activeTasks: number;
  overdueTasks: string[];
  dueTodayTasks: string[];
  dueTomorrowTasks: string[];
  completionPct: number;
  criticalCount: number;
  overdueCount: number;
  dueTodayCount: number;
  completedTodayCount: number;
  officerWorkload: { name: string; total: number; overdue: number; critical: number }[];
}

export interface NeedsAttentionTask {
  taskId: string;
  title: string;
  reasons?: string[];
}

async function readApi<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as (T & { error?: string; ok?: boolean }) | null;
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }
  return data;
}

export const fetchTodos = async (): Promise<{ ok: boolean; todos: TodoTask[] }> => {
  return readApi<{ ok: boolean; todos: TodoTask[] }>(
    await fetch("/api/todos", { credentials: "same-origin", cache: "no-store" }),
  );
};

export const fetchStats = async (): Promise<{ ok: boolean; stats: TodoStats }> => {
  return readApi<{ ok: boolean; stats: TodoStats }>(
    await fetch("/api/todos/stats", { credentials: "same-origin", cache: "no-store" }),
  );
};

export const createTodo = async (task: Partial<TodoTask>): Promise<{ ok: boolean; todo: TodoTask }> => {
  return readApi<{ ok: boolean; todo: TodoTask }>(
    await fetch("/api/todos", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    }),
  );
};

export const updateTodo = async (taskId: string, updates: Partial<TodoTask>): Promise<{ ok: boolean }> => {
  return readApi<{ ok: boolean }>(
    await fetch(`/api/todos/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }),
  );
};

export const deleteTodo = async (taskId: string): Promise<{ ok: boolean }> => {
  return readApi<{ ok: boolean }>(
    await fetch(`/api/todos/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    }),
  );
};

export const importTodos = async (): Promise<{ ok: boolean; imported: number }> => {
  return readApi<{ ok: boolean; imported: number }>(
    await fetch("/api/todos/import", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
};