import { useCallback, useEffect, useState } from "react";

const storageKey = (employeeId: string) => `kpfir.pinnedTasks.v1.${employeeId}`;
const completedStorageKey = (employeeId: string) => `kpfir.completedTasks.v1.${employeeId}`;

function readTaskIds(key: string): string[] {
  if (!key) return [];
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function usePinnedTasks(employeeId: string | undefined) {
  const key = employeeId ? storageKey(employeeId) : "";
  const [pinnedTaskIds, setPinnedTaskIds] = useState<string[]>(() => readTaskIds(key));

  useEffect(() => {
    setPinnedTaskIds(readTaskIds(key));
  }, [key]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key) setPinnedTaskIds(readTaskIds(key));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);

  const togglePinned = useCallback((taskId: string) => {
    setPinnedTaskIds((current) => {
      const next = current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : [...current, taskId];
      if (key) localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  }, [key]);

  const isPinned = useCallback(
    (taskId: string) => pinnedTaskIds.includes(taskId),
    [pinnedTaskIds],
  );

  return { pinnedTaskIds, isPinned, togglePinned };
}

export function useCompletedTasks(employeeId: string | undefined) {
  const key = employeeId ? completedStorageKey(employeeId) : "";
  const [completedTaskIds, setCompletedTaskIds] = useState<string[]>(() =>
    readTaskIds(key),
  );

  useEffect(() => {
    setCompletedTaskIds(readTaskIds(key));
  }, [key]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key) setCompletedTaskIds(readTaskIds(key));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);

  const markCompleted = useCallback((taskId: string) => {
    setCompletedTaskIds((current) => {
      if (current.includes(taskId)) return current;
      const next = [...current, taskId];
      if (key) localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  }, [key]);

  const isCompleted = useCallback(
    (taskId: string) => completedTaskIds.includes(taskId),
    [completedTaskIds],
  );

  return {
    completedTaskIds,
    isCompleted,
    markCompleted,
  };
}


