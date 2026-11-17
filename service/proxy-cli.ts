// Proxy mode's commands (this fork's own, FORK.md; docs/web-proxy.md); bin/shepherdr runs this with Bun:
//   shepherdr web proxy setup --bind <ip> --origin https://<name> [--port 7789]   write proxy.json (then restart)
//   shepherdr web proxy status | off                                              what it says now | remove it
//   shepherdr web pair [--name <device>]     a one-time code to pair a device (5 minutes), from the running service
//   shepherdr web devices                    the paired devices
//   shepherdr web revoke <id>                a device's cookie stops working at once
// pair, devices and revoke ask the service on 127.0.0.1 with its token, as the window does; the codes live only there.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, PORT, TOKEN } from "./paths.ts";
import { CONF_FILE, parseConf } from "./proxy.ts";

const RESTART = process.platform === "darwin"
  ? "launchctl kickstart -k gui/$(id -u)/dev.shepherdr.service"
  : "systemctl --user restart shepherdr";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const VALUED = new Set(["--bind", "--origin", "--port", "--name"]);
const words = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
const asJson = argv.includes("--json");
function fail(s: string, code = 1): never { console.error(`shepherdr: ${s}`); process.exit(code); }
const out = (x: unknown, text: string) => console.log(asJson ? JSON.stringify(x) : text);

/** The running service's port (its service.json) and token, for this machine's own calls. */
async function call(path: string, method = "GET", body?: unknown) {
  let port = PORT;
  try { port = JSON.parse(readFileSync(join(DATA, "service.json"), "utf8")).port || PORT; } catch {}
  let token = "";
  try { token = readFileSync(TOKEN, "utf8").trim(); } catch { fail(`no service token here (${TOKEN}): is Shepherdr's service installed?`); }
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => fail(`Shepherdr's service isn't answering on 127.0.0.1:${port}`));
  const x: any = await r.json().catch(() => ({}));
  if (!r.ok) fail(x.error ?? `the service said ${r.status}`);
  return x;
}

const [cmd, sub] = words;
if (cmd === "proxy" && sub === "setup") {
  const r = parseConf({ bind: flag("--bind"), port: flag("--port") ?? 7789, origin: flag("--origin") });
  if (!r.ok) fail(r.why, 2);
  const { bind, port, origin } = r.conf;
  writeFileSync(CONF_FILE(), JSON.stringify({ bind, port, origin }, null, 1) + "\n", { mode: 0o600 });
  out({ ok: true, ...r.conf }, `Proxy mode set: ${origin} → http://${bind}:${port} (${CONF_FILE()}).\n`
    + `Restart the service for it to take effect: ${RESTART}\nThen pair a device: shepherdr web pair`);
} else if (cmd === "proxy" && sub === "status") {
  const file = CONF_FILE();
  if (!existsSync(file)) out({ on: false }, "Proxy mode is off (no proxy.json).");
  else {
    let raw: any = null;
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch {}
    const r = parseConf(raw);
    out(r.ok ? { on: true, ...r.conf } : { on: false, error: r.why },
      r.ok ? `Proxy mode: ${r.conf.origin}/shepherdr/ → http://${r.conf.bind}:${r.conf.port} (${file})` : `Proxy mode is off: ${file}: ${r.why}`);
  }
} else if (cmd === "proxy" && sub === "off") {
  rmSync(CONF_FILE(), { force: true });
  out({ ok: true }, `Proxy mode is off once the service restarts: ${RESTART}`);
} else if (cmd === "pair") {
  const r = await call("/api/proxy/pair", "POST", { name: flag("--name") });
  out(r, `Code: ${r.code}  (works once, for 5 minutes)\nOn the device, open ${r.link} and type it.`);
} else if (cmd === "devices") {
  const r = await call("/api/proxy/devices");
  const live = (r.devices as any[]).filter((d) => !d.revoked);
  out(r, live.length ? live.map((d) => `${d.id}  ${d.name}  (paired ${new Date(d.created).toISOString().slice(0, 10)}, last seen ${new Date(d.lastSeen).toISOString().slice(0, 16)})`).join("\n") : "No paired devices.");
} else if (cmd === "revoke" && sub) {
  await call("/api/proxy/revoke", "POST", { id: sub });
  out({ ok: true }, `Revoked ${sub}.`);
} else {
  fail("shepherdr web proxy setup --bind <ip> --origin https://<name> [--port 7789] | web proxy status | web proxy off | web pair [--name <device>] | web devices | web revoke <id>", 2);
}
