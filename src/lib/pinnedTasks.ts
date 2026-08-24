import { useEffect, useState } from "react";

const storageKey = (employeeId: string) => `kpfir.pinnedTasks.v1.${employeeId}`;
const completedStorageKey = (employeeId: string) => `kpfir.completedTasks.v1.${employeeId}`;

function readPinned(employeeId: string): string[] {
  if (!employeeId) return [];
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(employeeId)) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function usePinnedTasks(employeeId: string | undefined) {
  const [pinnedTaskIds, setPinnedTaskIds] = useState<string[]>(() => readPinned(employeeId || ""));

  useEffect(() => {
    setPinnedTaskIds(readPinned(employeeId || ""));
  }, [employeeId]);

  const togglePinned = (taskId: string) => {
    setPinnedTaskIds((current) => {
      const next = current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : [...current, taskId];
      if (employeeId) localStorage.setItem(storageKey(employeeId), JSON.stringify(next));
      return next;
    });
  };

  return { pinnedTaskIds, isPinned: (taskId: string) => pinnedTaskIds.includes(taskId), togglePinned };
}

export function useCompletedTasks(employeeId: string | undefined) {
  const [completedTaskIds, setCompletedTaskIds] = useState<string[]>(() =>
    readPinned(completedStorageKey(employeeId || "")),
  );

  useEffect(() => {
    setCompletedTaskIds(readPinned(completedStorageKey(employeeId || "")));
  }, [employeeId]);

  const markCompleted = (taskId: string) => {
    setCompletedTaskIds((current) => {
      if (current.includes(taskId)) return current;
      const next = [...current, taskId];
      if (employeeId) localStorage.setItem(completedStorageKey(employeeId), JSON.stringify(next));
      return next;
    });
  };

  return {
    completedTaskIds,
    isCompleted: (taskId: string) => completedTaskIds.includes(taskId),
    markCompleted,
  };
}