// Fork (nishitpatel92): a space's live tasks under it in the Spaces sidebar (mods/spaces-chat/fork-tasks.js draws them).
// Which tasks show, which space each is under, and its dot. The status is the Tasks panel's own (core/tasks.js place()),
// so the sidebar never says other than the panel. Plain JS, no Herdr: what Herdr knows live comes in as arguments.
// Shared core: bin/sync-shared copies it into the mods in lib/COPIES (spaces-chat).
import { place, refOf } from "./tasks.js";

// Shown: at work, needing the person, or waiting on something other than a start (a dependency, the machine's limits,
// queued after its start, said ready and waiting in review). Never Done (nor archived), To do or Scheduled.
// The dot each status gets: "needs" (red), "working" (amber), "waiting" (grey).
export const DOT = { needs: "needs", working: "working", merging: "working", queued: "waiting", ready: "waiting" };
const ORDER = { needs: 0, working: 1, waiting: 2 };

const bareId = (id) => (id == null ? null : String(id).slice(String(id).lastIndexOf("/") + 1));

// The space a task is under: same machine, and its space id (task.space, else queue.space while it waits to start);
// with neither, the first space on its machine working in the list's folder. null: no space here.
// spaces: [{ id, machine, folder }] in the sidebar's order.
export function spaceOfTask(list, task, spaces) {
  const m = list.machine ?? null;
  const mine = spaces.filter((s) => (s.machine ?? null) === m);
  const want = bareId(task.space ?? task.queue?.space ?? null);
  if (want) return mine.find((s) => bareId(s.id) === want)?.id ?? null;
  return mine.find((s) => s.folder && s.folder === list.folder)?.id ?? null;
}

// lists: [{ machine, folder, slug, prefix, tasks }]; spaces as above; liveOf(list, task) -> place()'s live and helpers
// ({ live, helpers, loaded }). Map of space id -> its rows [{ ref, title, dot, section, list, task, live }], needs first,
// then working, then waiting, each by id.
export function liveTasks(lists, spaces, liveOf = () => ({}), now = Date.now()) {
  const out = new Map();
  for (const list of lists) {
    for (const task of list.tasks ?? []) {
      if (!["running", "ready", "queued"].includes(task.state) || task.archived) continue;
      const p = place(list, task, { ...liveOf(list, task), now });
      const dot = DOT[p.section];
      if (!dot) continue;
      const sp = spaceOfTask(list, task, spaces);
      if (sp == null) continue;
      if (!out.has(sp)) out.set(sp, []);
      out.get(sp).push({ space: sp, ref: refOf(list, task), title: task.title ?? "", dot, section: p.section, list, task, live: p.live });
    }
  }
  for (const rows of out.values()) rows.sort((a, b) => ORDER[a.dot] - ORDER[b.dot] || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return out;
}

// Follows a folder (the task lists): load() once, then again after each change. The watch is always armed before the
// read, so a change made while a read runs fires the next watch instead of being lost. A watch that fails is armed
// again after a pause and the folder read again. Each wait is at most `beat` ms (a reload's old build then ends at its
// next sleep). Runs until stop() says so.
export async function followFolder({ watch, sleep, load, stop = () => false, pause = 5000, beat = 5000 }) {
  const arm = () => watch().then(() => true, () => false);
  let w = arm();
  await load();
  while (!stop()) {
    const got = await Promise.race([w, sleep(beat).then(() => "wait")]);
    if (got === "wait") continue;
    if (!got) await sleep(pause);
    w = arm();
    await load();
  }
}
