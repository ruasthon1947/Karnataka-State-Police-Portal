const pendingKey = (employeeId: string) => `kpfir.digestPending.${employeeId}`;

/** Mark the morning briefing so it appears once after this sign-in. */
export function markDigestPending(employeeId: string) {
  if (!employeeId) return;
  sessionStorage.setItem(pendingKey(employeeId), "1");
}

export function hasDigestPending(employeeId: string) {
  if (!employeeId) return false;
  return sessionStorage.getItem(pendingKey(employeeId)) === "1";
}

export function clearDigestPending(employeeId: string) {
  if (!employeeId) return;
  sessionStorage.removeItem(pendingKey(employeeId));
}

