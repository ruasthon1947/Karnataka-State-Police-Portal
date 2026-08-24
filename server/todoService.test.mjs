import assert from "node:assert/strict";
import test from "node:test";

import { todoFilterForSession } from "./localDbPlugin.mjs";
import {
  computeTodoStats,
  filterTodosForAccess,
  sanitizeTodoCreate,
  sanitizeTodoUpdates,
} from "./todoService.mjs";

test("constables only request their own station tasks while supervisors retain their scope", () => {
  const constable = {
    employeeId: "5",
    name: "Amol",
    role: "Constable",
    policeStation: "100",
  };
  assert.deepEqual(todoFilterForSession(constable), {
    policeStation: "100",
    assignedTo: ["5", "Amol"],
  });
  assert.deepEqual(todoFilterForSession({ ...constable, role: "Inspector" }), {
    policeStation: "100",
  });
  assert.deepEqual(todoFilterForSession({ ...constable, role: "SP" }), {});
});

test("task access matches station IDs to names and limits constables to assigned or created tasks", () => {
  const todos = [
    { taskId: "1", policeStation: "Central PS", assignedTo: "Amol", createdBy: "9" },
    { taskId: "2", policeStation: "100", assignedTo: "6", createdBy: "5" },
    { taskId: "3", policeStation: "Central PS", assignedTo: "Other", createdBy: "9" },
    { taskId: "4", policeStation: "Other PS", assignedTo: "Amol", createdBy: "5" },
  ];
  const lookup = new Map([["100", "Central PS"]]);
  assert.deepEqual(
    filterTodosForAccess(todos, { policeStation: "100", assignedTo: ["5", "Amol"] }, lookup)
      .map((task) => task.taskId),
    ["1", "2"],
  );
});

test("task writes validate user data and ignore restricted update fields", () => {
  assert.throws(() => sanitizeTodoCreate({ title: "   " }), /title is required/i);
  assert.throws(() => sanitizeTodoCreate({ title: "Task", priority: "urgent" }), /priority/i);
  assert.throws(() => sanitizeTodoCreate({ title: "Task", dueDate: "2026-02-31" }), /due date/i);
  assert.deepEqual(
    sanitizeTodoUpdates({ status: "completed", taskId: "replacement", assignedTo: "someone-else" }),
    { status: "completed" },
  );
  assert.throws(() => sanitizeTodoUpdates({ assignedTo: "someone-else" }), /no supported/i);
  const created = sanitizeTodoCreate({
    title: "Task",
    taskId: "client-chosen-id",
    createdAt: "2000-01-01",
    assignedTo: "5",
    createdBy: "5",
    policeStation: "100",
  });
  assert.equal("taskId" in created, false);
  assert.equal("createdAt" in created, false);
});

test("task statistics use the Karnataka calendar date around UTC midnight", () => {
  const stats = computeTodoStats(
    [
      { taskId: "due", status: "pending", priority: "high", dueDate: "2026-08-25", assignedTo: "5" },
      { taskId: "late", status: "pending", priority: "critical", dueDate: "2026-08-24", assignedTo: "5" },
      { taskId: "done", status: "completed", priority: "medium", updatedAt: "2026-08-24T20:00:00.000Z", assignedTo: "5" },
    ],
    new Date("2026-08-24T20:00:00.000Z"),
  );
  assert.deepEqual(stats.dueTodayTasks, ["due"]);
  assert.deepEqual(stats.overdueTasks, ["late"]);
  assert.equal(stats.completedTodayCount, 1);
});
