// Fork (nishitpatel92): each space's live tasks under its row in the Spaces sidebar, as the old Herdr board did: at
// work (amber dot), needing you (red) or waiting on something (grey ring: a dependency, the machine's limits, review).
// Which ones and their dots are core/sidebar-tasks.js's (the Tasks panel's own status rules); this file reads the
// task lists and draws the rows. A click opens the task as the Tasks panel's does (its chat, inside that panel).
// Hooked into main.js by two lines (the import, attachTasks(this, cx) at the end of init()): it wraps the view's own
// row(), draw() and refreshMachines(), so upstream's code stays as it is.
// Refresh: this computer's lists when ~/.local/share/shepherdr/tasks changes (a watch, as the Tasks panel's); another
// machine's on the sidebar's own machine refresh (its files can't be watched); live agent status at every render.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, machines, watchFolder, layout, run, setShared } from "herdr";
import { agents, terminals, spaces } from "./live.js";
import { dirs } from "./dirs.js";
import { READ_LISTS, taskLists } from "./core/tasklists.js";
import { RANK, autoPrefix, machineOf } from "./core/tasks.js";
import { liveTasks } from "./core/sidebar-tasks.js";
import { sectionOf, data } from "./sections.js";
import { TEXT, RADIUS, red, amber } from "./ui.js";

const ID_FONT = "JetBrains Mono";
const helper = (k) => ["reviewer", "helper"].includes(k.labels?.["herdr.role"]) && !!k.parent;

export function attachTasks(view, cx) {
  const st = { byMachine: new Map(), raw: new Map(), reads: new Map(), rows: new Map() };
  view.forkTasks = st;

  // One machine's lists (null: this computer), read with the Tasks panel's READ_LISTS; unchanged text is skipped.
  const load = async (cx, machine = null) => {
    const k = machine ?? "";
    if (st.reads.has(k)) { st.reads.set(k, true); return; }
    st.reads.set(k, false);
    let text;
    try { text = (await exec("sh", ["-c", READ_LISTS], { on: machine ?? undefined })).stdout; }
    catch { return; } // out of reach: its last lists stay
    finally {
      const again = st.reads.get(k);
      st.reads.delete(k);
      if (again) cx.spawn(async (cx) => load(cx, machine));
    }
    if (st.raw.get(k) === text) return;
    st.raw.set(k, text);
    st.byMachine.set(k, taskLists(text).map((d) => ({ ...d, machine, prefix: d.prefix || autoPrefix(d.folder), tasks: Array.isArray(d.tasks) ? d.tasks : [] })));
    cx.notify();
  };

  // This computer's: once, then on every change of its tasks folder; a failed watch is tried again after 5 s.
  cx.spawn(async (cx) => load(cx, null));
  cx.spawn(async (cx) => {
    let w = null;
    for (;;) {
      w ??= watchFolder(dirs().tasks).then(() => true, () => false);
      const got = await Promise.race([w, cx.sleep(5000).then(() => "wait")]);
      if (got === "wait") continue;
      w = null;
      if (got) await load(cx, null);
      else await cx.sleep(5000);
    }
  });

  // Other machines': with the sidebar's own machine refresh (every 15 s), only those with spaces here.
  const refresh = view.refreshMachines.bind(view);
  view.refreshMachines = (cx) => {
    refresh(cx);
    const there = new Set(spaces().map((s) => s.machine).filter(Boolean));
    for (const m of [...st.byMachine.keys()]) if (m && !there.has(m)) { st.byMachine.delete(m); st.raw.delete(m); }
    for (const m of machines()) if (m.name && there.has(m.name) && m.layout === "ready") cx.spawn(async (cx) => load(cx, m.name));
  };

  // Once per render: every space's rows.
  const draw = view.draw.bind(view);
  view.draw = (cx) => {
    st.rows = st.byMachine.size ? liveTasks([...st.byMachine.values()].flat(), spaces(), agentsOf()) : new Map();
    return draw(cx);
  };

  // A space's row, then its tasks under it; none while its section (or Pinned) is folded.
  const row = view.row.bind(view);
  view.row = (r, t) => {
    const el = row(r, t);
    const tasks = st.rows.get(r.w.id);
    const folded = r.pinned ? data().pinnedFolded : sectionOf(r.w.id)?.folded;
    if (!tasks?.length || folded) return el;
    return v_flex().flex_none().child(el).children(tasks.map((x) => taskRow(x, r, t)));
  };
}

// A task's agents now, as the Tasks panel reads them (mods/tasks/main.js live(), helpers()): live terminals labelled
// with its key on its folder's machine; its worker's own reviewer or helper apart.
function agentsOf() {
  const ks = terminals().filter((k) => k.state === "live" && k.labels?.["herdr.task"]);
  const shown = new Map(agents().map((a) => [a.address, a]));
  const status = (k) => shown.get(k.address)?.status ?? (RANK[k.status] ? k.status : null);
  const ready = new Map(machines().map((m) => [m.name ?? null, m.layout]));
  return (list, task) => {
    const key = `${list.slug}#${task.id}`, m = list.machine ?? null;
    const mine = ks.filter((k) => k.labels["herdr.task"] === key && machineOf(k.address) === m);
    const live = mine.filter((k) => k.program?.key !== "shell" && !k.program?.shell && !helper(k))
      .map((k) => ({ address: k.address, status: status(k), role: k.labels["herdr.role"] ?? "worker", turn: k.turn,
        ...(typeof k.status_ms === "number" ? { since: k.status_ms } : {}) }));
    const own = new Set(live.map((a) => a.address.split("/").pop()));
    const helpers = mine.filter((k) => helper(k) && own.has(String(k.parent).split("/").pop())).map((k) => ({ address: k.address, status: status(k) }));
    return { live, helpers, loaded: ready.get(m) !== "loading" };
  };
}

function dot(kind, t) {
  const d = div().size(8).flex_none().rounded(4);
  if (kind === "needs") return d.bg(red());
  if (kind === "working") return d.bg(amber());
  return d.border(1.5).border_color(t.dim);
}

// Its dot under the space's name column, its id small and dim, its title cut to fit.
function taskRow(x, r, t) {
  return h_flex().id(`space-task-${r.w.id}-${x.ref}`).h(24).flex_none().pl(8 + (r.tree ? 22 + 13 + 9 : 18 + 9)).pr(8).gap(6)
    .items_center().rounded(RADIUS.card).cursor_pointer().hover((s) => s.bg(t.hover))
    .text_size(TEXT.label).text_color(t.muted)
    .on_click((_e, cx) => { cx.stop_propagation(); openTask(x); })
    .child(dot(x.dot, t))
    .child(div().flex_none().font_family(ID_FONT).text_size(TEXT.id).text_color(t.dim).child(x.ref))
    .child(div().flex_1().min_w(0).truncate().child(x.title));
}

// The Tasks panel's click (mods/tasks/main.js target(), openThread()): its worker (the one asking first), else its
// last agent's conversation, else why it waits; inside the Tasks panel. A layout without that view: its space.
const hasNode = (n, id) => Boolean(n && typeof n === "object") && (n.id === id || (n.children ?? []).some((c) => hasNode(c, id)));
function openTask(x) {
  const { list, task, live } = x;
  const m = list.machine ?? null;
  if (!hasNode(layout(), "tasks-thread")) {
    const sp = spaces().find((s) => s.id === x.space);
    if (sp) run("space.select", { id: sp.id });
    return;
  }
  const worker = live.find((a) => a.role !== "reviewer" && a.status === "blocked") ?? live.find((a) => a.role !== "reviewer") ?? live[0];
  const last = task.agents?.[task.agents.length - 1];
  const terminal = worker?.address ?? (last?.address ? (m ? `${m}/${last.address}` : last.address) : null);
  const log = !worker && last?.log ? { path: last.log, kind: last.agent ?? null } : null;
  const note = terminal ? null : x.section === "queued" ? "Waiting to start." : "This task hasn't started.";
  setShared("tasks.thread", { terminal, task: x.ref, title: task.title, key: { machine: m, folder: list.folder, slug: list.slug, id: task.id }, log, note, at: Date.now() });
  run("layout.select", { stack: "tasks", child: "tasks-thread" });
  if (hasNode(layout(), "tasks-thread-body")) run("layout.select", { stack: "tasks-thread-body", child: "tasks-thread-chat" });
}
