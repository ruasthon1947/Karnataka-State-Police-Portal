import crypto from "node:crypto";
import { readTable, writeTable, appendRow, updateRow, casesFromGoogle } from "./googleSheets.mjs";

const TODO_TAB = "TodoTasks";

const HEADERS = [
  "taskId", "title", "description", "status", "priority", 
  "assignedTo", "policeStation", "dueDate", "createdBy", 
  "createdAt", "updatedAt", "source", "sheetRowRef", "category"
];

function getSheetId() {
  const masterSheetId = String(process.env.GOOGLE_MASTER_SHEET_ID || process.env.GOOGLE_SHEET_ID || "").trim();
  if (!masterSheetId) {
    throw new Error("GOOGLE_MASTER_SHEET_ID is not configured in .env.");
  }
  return masterSheetId;
}

function toRowArray(task) {
  return HEADERS.map(h => String(task[h] ?? ""));
}

const TODO_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const TODO_CATEGORIES = new Set(["investigation", "court", "followup", "chargesheet"]);
const MUTABLE_FIELDS = new Set(["title", "description", "status", "priority", "dueDate", "category"]);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function validDate(value) {
  const date = cleanText(value, 10);
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError(400, "Due date must use YYYY-MM-DD format.");
  }
  return date;
}

export function sanitizeTodoCreate(taskData = {}) {
  const title = cleanText(taskData.title, 160);
  if (!title) throw httpError(400, "Task title is required.");
  const priority = cleanText(taskData.priority || "medium", 20).toLowerCase();
  const status = cleanText(taskData.status || "pending", 20).toLowerCase();
  const category = cleanText(taskData.category || "investigation", 30).toLowerCase();
  if (!TODO_PRIORITIES.has(priority)) throw httpError(400, "Invalid task priority.");
  if (!TODO_STATUSES.has(status)) throw httpError(400, "Invalid task status.");
  if (!TODO_CATEGORIES.has(category)) throw httpError(400, "Invalid task category.");
  return {
    title,
    description: cleanText(taskData.description, 2000),
    priority,
    status,
    category,
    dueDate: validDate(taskData.dueDate),
    assignedTo: cleanText(taskData.assignedTo, 160),
    policeStation: cleanText(taskData.policeStation, 160),
    createdBy: cleanText(taskData.createdBy, 160),
    source: "manual",
  };
}

export function sanitizeTodoUpdates(updates = {}) {
  const sanitized = {};
  for (const [field, value] of Object.entries(updates)) {
    if (!MUTABLE_FIELDS.has(field)) continue;
    if (field === "title") {
      const title = cleanText(value, 160);
      if (!title) throw httpError(400, "Task title is required.");
      sanitized.title = title;
    } else if (field === "description") {
      sanitized.description = cleanText(value, 2000);
    } else if (field === "dueDate") {
      sanitized.dueDate = validDate(value);
    } else {
      const normalized = cleanText(value, 30).toLowerCase();
      const allowed = field === "priority" ? TODO_PRIORITIES : field === "status" ? TODO_STATUSES : TODO_CATEGORIES;
      if (!allowed.has(normalized)) throw httpError(400, `Invalid task ${field}.`);
      sanitized[field] = normalized;
    }
  }
  if (Object.keys(sanitized).length === 0) throw httpError(400, "No supported task updates were provided.");
  return sanitized;
}

export function filterTodosForAccess(todos, filter = {}, stationLookup = new Map()) {
  let filtered = [...todos];
  if (filter.policeStation) {
    const requested = String(filter.policeStation).trim();
    const requestedName = resolveStationName(requested, stationLookup);
    filtered = filtered.filter((task) => {
      const taskStation = String(task.policeStation || "").trim();
      return taskStation === requested || resolveStationName(taskStation, stationLookup) === requestedName;
    });
  }
  if (filter.assignedTo) {
    const assignees = (Array.isArray(filter.assignedTo) ? filter.assignedTo : [filter.assignedTo])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    filtered = filtered.filter((task) => {
      const assignedTo = String(task.assignedTo || "").trim().toLowerCase();
      const createdBy = String(task.createdBy || "").trim().toLowerCase();
      return assignees.includes(assignedTo) || assignees.includes(createdBy);
    });
  }
  if (filter.status) filtered = filtered.filter((task) => task.status === filter.status);
  return filtered;
}

function sameStation(left, right, stationLookup) {
  const leftValue = String(left || "").trim();
  const rightValue = String(right || "").trim();
  return leftValue === rightValue || resolveStationName(leftValue, stationLookup) === resolveStationName(rightValue, stationLookup);
}

function taskOwnedBy(task, session) {
  const identities = [session.employeeId, session.name]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return identities.includes(String(task.assignedTo || "").trim().toLowerCase()) ||
    identities.includes(String(task.createdBy || "").trim().toLowerCase());
}

export async function fetchTodos(req, filter = {}) {
  const sheetId = getSheetId();
  const tableData = await readTable(sheetId, TODO_TAB);
  
  // If the table doesn't have headers yet, we initialize it on next write
  if (!tableData.headers || tableData.headers.length === 0) {
    return [];
  }
  
  const stationLookup = filter.policeStation ? await buildStationLookup() : new Map();
  return filterTodosForAccess(tableData.rows, filter, stationLookup);
}

export async function createTodo(req, taskData) {
  const sheetId = getSheetId();
  taskData = sanitizeTodoCreate(taskData);
  
  if (!taskData.taskId) {
    taskData.taskId = crypto.randomUUID();
  }
  
  const newTask = {
    taskId: taskData.taskId,
    title: taskData.title || "",
    description: taskData.description || "",
    status: taskData.status || "pending",
    priority: taskData.priority || "medium",
    assignedTo: taskData.assignedTo || "",
    policeStation: taskData.policeStation || "",
    dueDate: taskData.dueDate || "",
    createdBy: taskData.createdBy || "",
    createdAt: taskData.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: taskData.source || "manual",
    sheetRowRef: taskData.sheetRowRef || "",
    category: taskData.category || "investigation"
  };
  
  const tableData = await readTable(sheetId, TODO_TAB);
  
  if (!tableData.headers || tableData.headers.length === 0) {
    // Need to initialize the table with headers first
    await writeTable(sheetId, TODO_TAB, HEADERS, [newTask]);
  } else {
    // Append to existing
    await appendRow(sheetId, TODO_TAB, toRowArray(newTask));
  }
  
  return newTask;
}

export async function updateTodo(req, taskId, updates) {
  const session = req?.session;
  if (!session) throw httpError(401, "Your session has expired. Please sign in again.");
  const sheetId = getSheetId();
  updates = sanitizeTodoUpdates(updates);
  const tableData = await readTable(sheetId, TODO_TAB);
  
  if (!tableData.headers || tableData.headers.length === 0) {
    throw new Error(`Task not found: ${taskId} (Sheet headers missing)`);
  }
  
  console.log("[updateTodo] Looking for taskId:", taskId);
  const idx = tableData.rows.findIndex(r => String(r.taskId).trim() === String(taskId).trim());
  if (idx === -1) {
    throw new Error(`Task not found: ${taskId}`);
  }
  
  const existingTask = tableData.rows[idx];
  const stationLookup = await buildStationLookup();
  const withinStation = sameStation(existingTask.policeStation, session.policeStation, stationLookup);
  
  // Security Audit: Check Authorization (IDOR Prevention)
  if (session.role === "Inspector") {
    if (!withinStation) {
      throw httpError(403, "Forbidden: You cannot modify tasks outside your station.");
    }
  } else if (session.role === "Constable") {
    if (!withinStation) {
      throw httpError(403, "Forbidden: You cannot modify tasks outside your station.");
    }
    if (!taskOwnedBy(existingTask, session)) {
      throw httpError(403, "Forbidden: You can only modify tasks assigned to you or created by you.");
    }
  }
  
  const merged = { ...existingTask, ...updates, updatedAt: new Date().toISOString() };
  
  // sheetRowIndex is 1-based, and headers take row 1. So data row 0 is at row 2.
  const sheetRowIndex = idx + 2;
  const rowArray = HEADERS.map(h => String(merged[h] || ""));
  
  await updateRow(sheetId, TODO_TAB, sheetRowIndex, rowArray);
  
  return merged;
}

export async function deleteTodo(req, taskId) {
  const session = req?.session;
  if (!session) throw httpError(401, "Your session has expired. Please sign in again.");
  const sheetId = getSheetId();
  const tableData = await readTable(sheetId, TODO_TAB);

  if (!tableData.headers || tableData.headers.length === 0) {
    return { ok: true, deleted: false };
  }

  const taskToDelete = tableData.rows.find((r) => String(r.taskId).trim() === String(taskId).trim());

  if (!taskToDelete) {
    return { ok: true, deleted: false };
  }

  const stationLookup = await buildStationLookup();
  const withinStation = sameStation(taskToDelete.policeStation, session.policeStation, stationLookup);
  const ownsTask = taskOwnedBy(taskToDelete, session);

  // Security Audit: Check Authorization (IDOR Prevention)
  if (session.role === "Inspector") {
    if (!withinStation && !ownsTask) {
      throw Object.assign(new Error("Forbidden: You cannot delete tasks outside your station."), { status: 403 });
    }
  } else if (session.role === "Constable") {
    if (!ownsTask) {
      throw Object.assign(
        new Error("Forbidden: You can only delete tasks assigned to you or created by you."),
        { status: 403 },
      );
    }
  }

  const remainingRows = tableData.rows.filter((row) => String(row.taskId).trim() !== String(taskId).trim());
  try {
    await writeTable(sheetId, TODO_TAB, HEADERS, remainingRows);
  } catch (err) {
    console.error('[deleteTodo] Failed to write updated table to Google Sheets:', err && err.stack ? err.stack : err);
    // Throw a clearer, but safe error for the client while preserving server logs
    throw Object.assign(new Error('Failed to delete task from backend data store.'), { status: 500 });
  }

  return { ok: true, deleted: true };
}

export async function computeStats(req, filter = {}) {
  const todos = await fetchTodos(req, filter);
  return computeTodoStats(todos);
}

function dateInKolkata(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function computeTodoStats(todos, now = new Date()) {
  const todayStr = dateInKolkata(now);
  const tomorrowDate = new Date(`${todayStr}T00:00:00Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);
  
  const active = todos.filter(t => t.status !== "completed");
  const completed = todos.filter(t => t.status === "completed");
  
  const overdue = active.filter(t => {
    if (!t.dueDate) return false;
    return t.dueDate.slice(0, 10) < todayStr;
  });
  
  const dueToday = active.filter(t => {
    if (!t.dueDate) return false;
    return t.dueDate.slice(0, 10) === todayStr;
  });
  
  const dueTomorrow = active.filter(t => {
    if (!t.dueDate) return false;
    return t.dueDate.slice(0, 10) === tomorrowStr;
  });
  
  const critical = active.filter(t => t.priority === "critical");
  const high = active.filter(t => t.priority === "high");
  
  const completedToday = completed.filter(t => {
    if (!t.updatedAt) return false;
    const updatedAt = new Date(t.updatedAt);
    return !Number.isNaN(updatedAt.getTime()) && dateInKolkata(updatedAt) === todayStr;
  });
  
  // Officer workload distribution
  const officerMap = {};
  for (const t of active) {
    const officer = t.assignedTo || "Unassigned";
    if (!officerMap[officer]) officerMap[officer] = { total: 0, overdue: 0, critical: 0 };
    officerMap[officer].total += 1;
    if (t.dueDate && t.dueDate.slice(0, 10) < todayStr) officerMap[officer].overdue += 1;
    if (t.priority === "critical") officerMap[officer].critical += 1;
  }
  const officerWorkload = Object.entries(officerMap)
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.total - a.total);
  
  const completionPct = todos.length > 0 ? Math.round((completed.length / todos.length) * 100) : 0;
  
  // "Needs attention" = overdue + critical + due today (deduped by taskId)
  const needsAttentionMap = new Map();
  for (const t of [...overdue, ...critical, ...dueToday]) {
    if (!needsAttentionMap.has(t.taskId)) {
      const reasons = [];
      if (t.dueDate && t.dueDate.slice(0, 10) < todayStr) reasons.push("overdue");
      if (t.priority === "critical") reasons.push("critical");
      if (t.dueDate && t.dueDate.slice(0, 10) === todayStr) reasons.push("due_today");
      needsAttentionMap.set(t.taskId, { ...t, reasons });
    }
  }
  const needsAttention = Array.from(needsAttentionMap.values());
  
  return {
    totalTasks: todos.length,
    activeTasks: active.length,
    completedTasks: completed.length,
    completionPct,
    overdueCount: overdue.length,
    overdueTasks: overdue.map(t => t.taskId),
    dueTodayCount: dueToday.length,
    dueTodayTasks: dueToday.map(t => t.taskId),
    dueTomorrowCount: dueTomorrow.length,
    dueTomorrowTasks: dueTomorrow.map(t => t.taskId),
    criticalCount: critical.length,
    highCount: high.length,
    completedTodayCount: completedToday.length,
    officerWorkload,
    needsAttention,
  };
}

let stationLookupPromise = null;
let stationLookupExpiresAt = 0;

// Build a short-lived UnitID → UnitName lookup so the parallel list/stat calls
// do not make duplicate Unit-sheet requests.
async function buildStationLookup() {
  if (stationLookupPromise && stationLookupExpiresAt > Date.now()) {
    return stationLookupPromise;
  }
  const sheetId = getSheetId();
  stationLookupPromise = (async () => {
    try {
      const unitTable = await readTable(sheetId, "Unit");
      const map = new Map();
      for (const row of unitTable.rows) {
        if (row.UnitID && row.UnitName) {
          map.set(row.UnitID, row.UnitName);
        }
      }
      stationLookupExpiresAt = Date.now() + 5 * 60_000;
      return map;
    } catch (err) {
      stationLookupExpiresAt = 0;
      console.warn("[TodoService] Could not load Unit table for station name lookup:", err.message);
      return new Map();
    }
  })();
  return stationLookupPromise;
}

function resolveStationName(stationIdOrName, lookup) {
  if (!stationIdOrName) return "";
  // If the lookup has this as a key, it's an ID → resolve to name
  if (lookup.has(stationIdOrName)) {
    return lookup.get(stationIdOrName);
  }
  // Otherwise it's already a name (or unknown)
  return stationIdOrName;
}

export async function importFromGoogleSheets(req, session) {
  // We'll sync legacy columns from TodoTasks AND auto-import recent unsolved cases
  const creatorId = session.employeeId;
  const policeStation = session.policeStation;
  
  const sheetId = getSheetId();
  const tableData = await readTable(sheetId, TODO_TAB);
  
  if (!tableData.headers || tableData.headers.length === 0) {
    // Initialize the sheet
    await writeTable(sheetId, TODO_TAB, HEADERS, []);
  }
  
  // Build station ID → name lookup
  const stationLookup = await buildStationLookup();
  const stationName = resolveStationName(policeStation, stationLookup);
  
  // Backwards compatibility with the manual columns they might have added
  let newRowsCount = 0;
  let rowsModified = false;
  
  const validatedRows = tableData.rows.map(row => {
    let modified = false;
    // Map custom columns (e.g. Title instead of taskId) if someone hand-typed them
    if (!row.taskId && (row.Title || row.title)) {
      row.taskId = crypto.randomUUID();
      row.title = row.Title || row.title;
      row.description = row.Description || row.description || "";
      row.priority = (row.Priority || row.priority || "medium").toLowerCase();
      row.assignedTo = row.AssignedTo || row.assignedTo || "";
      row.policeStation = resolveStationName(row.PoliceStation || row.policeStation || "", stationLookup);
      row.dueDate = row.DueDate || row.dueDate || "";
      row.category = row.Category || row.category || "investigation";
      row.status = row.Status || row.status || "pending";
      row.createdAt = new Date().toISOString();
      row.updatedAt = new Date().toISOString();
      row.source = "google_sheets";
      row.createdBy = creatorId;
      modified = true;
      newRowsCount++;
    }
    
    // Fix any existing rows that still have a numeric station ID
    if (row.policeStation && stationLookup.has(row.policeStation)) {
      row.policeStation = stationLookup.get(row.policeStation);
      modified = true;
    }
    
    // Clean up casing
    if (row.Title) { delete row.Title; modified = true; }
    if (row.Description) { delete row.Description; modified = true; }
    
    if (modified) rowsModified = true;
    return row;
  });
  
  // --- 2. Auto-import unsolved recent cases for this station ---
  try {
    const casesData = await casesFromGoogle();
    if (casesData && casesData.rows) {
      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      
      const unsolvedRecent = casesData.rows.filter(c => {
        // Filter by station — match the raw ID or the resolved name
        const caseStation = String(c.PoliceStation || "").trim();
        const resolvedCaseStation = resolveStationName(caseStation, stationLookup);
        const sessStationStr = String(policeStation).trim();
        if (caseStation !== sessStationStr && resolvedCaseStation !== stationName) return false;
        
        // Filter out closed/solved
        const status = (c.Status || "").toLowerCase();
        if (status.includes("closed") || status.includes("charge-sheeted") || status.includes("solved") || status.includes("undetected") || status.includes("un-traced") || status.includes("untraced")) {
          return false;
        }
        
        // Filter by recent (last 30 days)
        if (c.CrimeRegisteredDate) {
          const regDate = new Date(c.CrimeRegisteredDate).getTime();
          if (!isNaN(regDate) && (now - regDate) < THIRTY_DAYS_MS) {
            return true;
          }
        }
        return false;
      });
      
      const existingRefs = new Set(validatedRows.map(r => r.sheetRowRef));
      
      const generateBrief = (c) => {
        if (c.BriefFacts && c.BriefFacts.trim() !== "") {
          return c.BriefFacts;
        }
        const acc = c.AccusedNames ? c.AccusedNames.replace(/;/g, " and ") : "unknown persons";
        const comp = c.Complainant || "The complainant";
        const crime = c.CrimeSubHead || c.CrimeHead || c.CaseCategory || "an offence";
        return `${comp} reported that ${acc} committed ${crime}.`;
      };
      
      unsolvedRecent.forEach(c => {
        const ref = `case_${c.CrimeNo || c.CaseMasterID}`;
        const autoBrief = generateBrief(c);
        
        // Update existing rows if they have a missing brief
        if (existingRefs.has(ref)) {
          const existingRow = validatedRows.find(r => r.sheetRowRef === ref);
          if (existingRow && (existingRow.description.endsWith("Brief: ") || existingRow.description.endsWith("Brief:"))) {
            existingRow.description = `Recent unsolved case (${c.CrimeHead || c.CaseCategory}). Brief: ${autoBrief}`;
            rowsModified = true;
          }
        }
        
        if (!existingRefs.has(ref)) {
          const newTask = {
            taskId: crypto.randomUUID(),
            title: `Investigate FIR ${c.CrimeNo || c.CaseMasterID}`,
            description: `Recent unsolved case (${c.CrimeHead || c.CaseCategory}). Brief: ${autoBrief}`,
            status: "pending",
            priority: "high",
            assignedTo: c.Officer || "",
            policeStation: resolveStationName(c.PoliceStation, stationLookup),
            dueDate: "",
            createdBy: creatorId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: "case_import",
            sheetRowRef: ref,
            category: "investigation"
          };
          validatedRows.push(newTask);
          newRowsCount++;
          rowsModified = true;
          existingRefs.add(ref);
        }
      });
    }
  } catch (err) {
    console.warn("Failed to auto-import recent cases:", err.message);
  }
  
  if (rowsModified) {
    await writeTable(sheetId, TODO_TAB, HEADERS, validatedRows);
  }
  
  return { 
    imported: newRowsCount, 
    total: validatedRows.length,
    newRows: newRowsCount,
    message: `Synced with Google Sheets. Auto-imported recent unsolved cases for ${stationName}.`
  };
}