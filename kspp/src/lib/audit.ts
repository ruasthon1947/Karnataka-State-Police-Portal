export type AuditEvent = {
  EventID: string;
  Timestamp: string;
  OfficerID: string;
  OfficerName: string;
  Role: string;
  PoliceStation: string;
  Action: string;
  TargetType: string;
  TargetID: string;
  Result: string;
  StatusCode: string;
  Details: string;
  RequestID: string;
  PreviousHash: string;
  EventHash: string;
};

export type AuditResponse = {
  ok: boolean;
  events: AuditEvent[];
  total: number;
  integrity: {
    verified: boolean;
    checked: number;
    brokenEventIds: string[];
  };
  storage: {
    persistent: boolean;
    mode: string;
    syncPending: boolean;
    error: string;
  };
};

export type AuditFilters = {
  action?: string;
  result?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || "The audit trail could not be loaded.");
  }
  return data as T;
}

export async function fetchAuditEvents(filters: AuditFilters = {}) {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.result) params.set("result", filters.result);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.query) params.set("q", filters.query);
  params.set("limit", String(filters.limit || 100));
  return readJson<AuditResponse>(
    await fetch(`/api/audit-events?${params.toString()}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function recordAuditEvent(input: {
  action: "SEARCH" | "RECORD_ACCESS" | "REPORT_EXPORT" | "REPORT_PRINT";
  targetType: string;
  targetId?: string;
  result?: "SUCCESS" | "FAILED" | "PARTIAL";
  details?: Record<string, unknown>;
}) {
  try {
    const response = await fetch("/api/audit-events", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return response.ok;
  } catch {
    // Auditing is best-effort in the browser; the primary officer workflow
    // must remain usable during a temporary network interruption.
    return false;
  }
}
