// Fork (nishitpatel92): which tasks the Spaces sidebar lists under each space (core/sidebar-tasks.js).
import { describe, expect, test } from "bun:test";
import { liveTasks, spaceOfTask, followFolder } from "./sidebar-tasks.js";

const NOW = 1_800_000_000_000;
const OLD = NOW - 3600000;
const list = (tasks, more = {}) => ({ slug: "dev-x", prefix: "X", folder: "/f", machine: null, tasks, ...more });
const SPACES = [{ id: "sp1", machine: null, folder: "/f" }, { id: "sp2", machine: null, folder: "/g" }, { id: "sp1", machine: "vm", folder: "/f" }];
// Agents per task, by id: { 1: [{ address, status, since }] }.
const agents = (by) => (_l, t) => ({ live: by[t.id] ?? [], loaded: true });
const ids = (rows) => (rows ?? []).map((r) => `${r.ref}:${r.dot}`);

describe("the sidebar's live tasks", () => {
  const tasks = [
    { id: 1, title: "At work", state: "running", started: OLD, space: "sp1" },
    { id: 2, title: "Asking", state: "running", started: OLD, space: "sp1" },
    { id: 3, title: "Stopped", state: "running", started: OLD, space: "sp1" },
    { id: 4, title: "Waits on X-1", state: "queued", after: [1], queue: { space: "sp1" } },
    { id: 5, title: "In review", state: "ready", started: OLD, ready_at: OLD, space: "sp1" },
    { id: 6, title: "Finished", state: "done", started: OLD, space: "sp1" },
    { id: 7, title: "Archived", state: "done", archived: OLD, space: "sp1" },
    { id: 8, title: "Not started", state: "todo" },
    { id: 9, title: "Later", state: "scheduled", scheduled_for: NOW + 3600000 },
  ];
  const live = agents({ 1: [{ address: "t1", status: "working" }], 2: [{ address: "t2", status: "blocked" }] });
  const got = liveTasks([list(tasks)], SPACES, live, NOW);

  test("working, needs you and waiting show; done, archived, to do and scheduled don't", () => {
    expect(ids(got.get("sp1"))).toEqual(["X-2:needs", "X-3:needs", "X-1:working", "X-4:waiting", "X-5:waiting"]);
    expect([...got.keys()]).toEqual(["sp1"]);
  });

  test("an archived task that isn't done yet still doesn't show", () => {
    const g = liveTasks([list([{ id: 1, state: "running", started: OLD, archived: OLD, space: "sp1" }])], SPACES, agents({ 1: [{ address: "t1", status: "working" }] }), NOW);
    expect(g.size).toBe(0);
  });

  test("each row has its id, title, dot and its task's list for the click", () => {
    const r = got.get("sp1").find((x) => x.ref === "X-1");
    expect(r).toMatchObject({ ref: "X-1", title: "At work", dot: "working", section: "working" });
    expect(r.list.slug).toBe("dev-x");
    expect(r.live.map((a) => a.address)).toEqual(["t1"]);
  });
});

describe("grouping by space", () => {
  test("by the task's space, else its queue's space, else the space working in its list's folder", () => {
    const tasks = [
      { id: 1, state: "running", started: NOW - 1000, space: "sp2" },        // its space, though its list is sp1's folder
      { id: 2, state: "queued", queue: { space: "sp2" } },                    // before start: queue.space
      { id: 3, state: "running", started: NOW - 1000 },                       // neither: the folder's space
    ];
    const g = liveTasks([list(tasks)], SPACES, () => ({}), NOW);
    expect(ids(g.get("sp2"))).toEqual(["X-1:working", "X-2:waiting"]);
    expect(ids(g.get("sp1"))).toEqual(["X-3:working"]);
  });

  test("a machine's tasks go under that machine's space; ids may carry the machine", () => {
    const here = list([{ id: 1, state: "running", started: NOW - 1000, space: "sp1" }]);
    const there = list([{ id: 2, state: "running", started: NOW - 1000, space: "vm/sp1" }], { machine: "vm" });
    expect(spaceOfTask(here, here.tasks[0], SPACES)).toBe("sp1");
    expect(spaceOfTask(there, there.tasks[0], SPACES)).toBe("sp1");
    expect(spaceOfTask(there, there.tasks[0], SPACES.filter((s) => s.machine !== "vm"))).toBeNull();
  });

  test("a task whose space isn't here (or a name, not an id) shows under no space", () => {
    const g = liveTasks([list([{ id: 1, state: "running", started: NOW - 1000, space: "agent-workspace" }])], SPACES, () => ({}), NOW);
    expect(g.size).toBe(0);
  });

  test("two lists' tasks under one space, sorted by status then id", () => {
    const a = list([{ id: 10, state: "running", started: NOW - 1000, space: "sp1" }]);
    const b = list([{ id: 2, state: "running", started: NOW - 1000, space: "sp1" }], { slug: "dev-y", prefix: "Y", folder: "/y" });
    expect(ids(liveTasks([a, b], SPACES, () => ({}), NOW).get("sp1"))).toEqual(["X-10:working", "Y-2:working"]);
  });
});

describe("following the task lists' folder", () => {
  const run = (watches, rounds) => {
    const log = [];
    let n = 0;
    return followFolder({
      watch: () => { const r = watches[n++] ?? "never"; log.push(`watch:${r}`); return r === "change" ? Promise.resolve() : r === "fail" ? Promise.reject(new Error("gone")) : new Promise(() => {}); },
      sleep: () => Promise.resolve(),
      load: async () => { log.push("load"); },
      stop: () => log.filter((x) => x.startsWith("watch")).length >= rounds,
    }).then(() => log);
  };

  test("reads once, then after each change", async () => {
    expect(await run(["change", "change"], 2)).toEqual(["load", "watch:change", "load", "watch:change", "load"]);
  });

  test("a failed watch reads the lists again once it is armed again (a change in the pause isn't lost)", async () => {
    expect(await run(["fail", "change"], 2)).toEqual(["load", "watch:fail", "load", "watch:change", "load"]);
  });
});
