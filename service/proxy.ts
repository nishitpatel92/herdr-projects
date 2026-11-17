// Proxy mode (this fork's own, FORK.md; docs/web-proxy.md): the web app through a trusted reverse proxy (Caddy on a
// home server, reached over the LAN and WireGuard) instead of tailscale serve, with each device paired once.
// Off unless proxy.json in the service's folder says { "bind": <IP>, "port": <N>, "origin": "https://<name>" }. Then a
// second listener on bind:port serves the same app (the same fetch and sockets as the one on 127.0.0.1), and the
// listener a request came in on decides how it gets in:
// - on 127.0.0.1: as before (auth.ts gate: tailscale serve's owner, or the local token); never through here;
// - on the proxy listener: only with a paired device's cookie (devices.ts), on the configured name, with the page's
//   own origin and x-shepherdr: 1 for writes, as gate() asks of the tailnet. It trusts no header the client could
//   send through the proxy: Tailscale's login and Authorization are dropped before anything reads them.
// Everything is behind pairing, reads too. Pairing (/shepherdr/pair) and the devices page (/shepherdr/devices) are
// plain pages made here; codes come from the CLI (`shepherdr web pair`, POST /api/proxy/pair on 127.0.0.1 with the
// token) or from a device already paired.
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Pass } from "./auth.ts";
import { DATA } from "./paths.ts";
import { Devices, cleanName, type Shown } from "./devices.ts";
import { devicesPage, pairPage } from "./proxy-pages.ts";

export type ProxyConf = { bind: string; port: number; origin: string; host: string };
export const CONF_FILE = () => join(DATA, "proxy.json");
export const COOKIE = "shepherdr_device";
const MAX_AGE = 400 * 24 * 3600;
const RETRY = 30_000;

/** An address that means every interface, in any spelling: 0.0.0.0, ::, 0:0::0, ::ffff:0.0.0.0, ::ffff:0:0, … */
export function everyInterface(ip: string) {
  if (isIP(ip) === 4) return ip === "0.0.0.0";
  if (isIP(ip) !== 6) return false;
  let s = ip.split("%")[0].toLowerCase();
  const v4 = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) { const [a, b, c, d] = v4.slice(2).map(Number); s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const hs = head ? head.split(":") : [], ts = tail ? tail.split(":") : [];
  const all = tail === null ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts];
  const n = all.map((x) => parseInt(x || "0", 16));
  const zero = (xs: number[]) => xs.every((v) => v === 0);
  return zero(n) || (zero(n.slice(0, 5)) && n[5] === 0xffff && zero(n.slice(6)));
}
const SOCKETS = new Set(["/api/ws", "/api/terminal", "/api/browser", "/api/voice"]);
const READS = new Set(["GET", "HEAD"]);

/** proxy.json's settings checked: an IP literal that isn't every interface, a port, an https origin with no path. */
export function parseConf(raw: any): { ok: true; conf: ProxyConf } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object") return { ok: false, why: "not a JSON object" };
  const bind = String(raw.bind ?? "").trim();
  if (!isIP(bind)) return { ok: false, why: `bind must be an IP address (got ${JSON.stringify(raw.bind ?? null)})` };
  if (everyInterface(bind)) return { ok: false, why: "bind may not be every interface (0.0.0.0 or ::): name the address the proxy reaches" };
  const port = raw.port === undefined ? 7789 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: "port must be 1-65535" };
  let u: URL;
  try { u = new URL(String(raw.origin ?? "")); } catch { return { ok: false, why: "origin must be like https://shepherdr.example" }; }
  if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash || String(raw.origin).replace(/\/$/, "") !== u.origin)
    return { ok: false, why: "origin must be https://<name>[:port], nothing after it" };
  return { ok: true, conf: { bind, port, origin: u.origin, host: u.host } };
}

/** proxy.json now, or null (missing or invalid: the mode is off, and an invalid file says why in the log). */
export function readConf(file = CONF_FILE(), log = (s: string) => console.error(s)): ProxyConf | null {
  if (!existsSync(file)) return null;
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { log(`proxy: ${file} isn't JSON; proxy mode is off`); return null; }
  const r = parseConf(raw);
  if (!r.ok) { log(`proxy: ${file}: ${r.why}; proxy mode is off`); return null; }
  return r.conf;
}

/** The cookie's value from a Cookie header. */
export function cookieOf(req: Request) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

const strip = (p: string) => (p.startsWith("/shepherdr/") ? p.slice(10) : p);
const page = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, {
  status,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...extra },
});
const no = (status: number, why: string) => new Response(why, { status, headers: { "cache-control": "no-store" } });
const json = (x: unknown, status = 200) => Response.json(x, { status, headers: { "cache-control": "no-store" } });

// gate()'s page link (auth.ts), for the proxy listener: a top-level GET navigation to a page, not the API or a socket
function pageLink(req: Request, socket: boolean) {
  const h = req.headers;
  if (socket || req.method !== "GET") return false;
  if (h.get("sec-fetch-mode") !== "navigate" || h.get("sec-fetch-dest") !== "document") return false;
  return !/^\/api(\/|$)/.test(strip(new URL(req.url).pathname));
}
const navigation = (req: Request) => req.method === "GET" && (req.headers.get("sec-fetch-dest") === "document"
  || (!req.headers.has("sec-fetch-dest") && (req.headers.get("accept") ?? "").includes("text/html")));

type Fetch = (req: Request, srv: any) => Response | undefined | Promise<Response | undefined>;
type ProxyPass = Extract<Pass, { ok: true }> & { device: Shown };

export class Proxy {
  private passes = new WeakMap<Request, ProxyPass>();
  constructor(readonly conf: ProxyConf | null, readonly devices: Devices, private log = (s: string) => console.log(s)) {}

  // Only while the proxy listener is up: until it is (or when it can't start), the link and push stay the tailnet's
  get origin() { return this.conf && this.server ? this.conf.origin : null; }
  get link() { return this.origin ? `${this.origin}/shepherdr/` : null; }
  pass(req: Request): Pass | null { return this.passes.get(req) ?? null; }
  proxied(req: Request) { return this.passes.has(req); }
  device(req: Request) { const p = this.passes.get(req); return p ? `proxy:${p.device.id}` : null; }

  /** A same-origin form post from a page on the configured name (pairing, the devices page). */
  private sameOrigin(req: Request) {
    return req.headers.get("origin") === this.conf!.origin && req.headers.get("sec-fetch-site") === "same-origin";
  }

  /** What the proxy listener does with a request before the app sees it: an answer of its own, or the app's. */
  async front(req: Request, srv: any, next: Fetch): Promise<Response | undefined> {
    const c = this.conf!;
    const h = req.headers;
    for (const k of [...h.keys()]) if (k.startsWith("tailscale-") || k === "authorization") h.delete(k);
    const host = (h.get("host") ?? "").toLowerCase();
    if (host !== c.host && host !== `${c.host}:443`) return no(421, "wrong host");
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/shepherdr") return Response.redirect(`${c.origin}/shepherdr/`, 302);
    const path = strip(url.pathname);
    const socket = SOCKETS.has(path) || (h.get("upgrade") ?? "").toLowerCase() === "websocket";
    if (req.method === "OPTIONS") return no(403, "no cross-site requests");
    // another site, or a sibling name on the same private domain (*.blackbox is one site): only a link to a page
    const site = h.get("sec-fetch-site");
    if ((site === "cross-site" || site === "same-site") && !pageLink(req, socket)) return no(403, site);

    if (url.pathname === "/shepherdr/pair") {
      if (req.method === "GET") return page(pairPage());
      if (req.method !== "POST") return no(405, "GET or POST");
      if (!this.sameOrigin(req)) return no(403, "pair from this site's own page");
      const form = await req.formData().catch(() => null);
      const r = this.devices.pair(form?.get("code"), form?.get("name"));
      if (!r.ok) return page(pairPage(r.why), 403);
      return new Response(null, { status: 303, headers: { location: "/shepherdr/", "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${r.cookie}; HttpOnly; Secure; SameSite=Strict; Path=/shepherdr; Max-Age=${MAX_AGE}` } });
    }

    const device = this.devices.check(cookieOf(req));
    if (!device) return navigation(req) && !socket ? page(pairPage(), 401) : no(401, "pair this device first");

    if (url.pathname === "/shepherdr/devices") return this.devicesRoute(req, device);
    if (/^\/api\/proxy(\/|$)/.test(path)) return no(403, "only on this machine");
    const write = socket || !READS.has(req.method);
    if (write) {
      if (h.get("origin") !== c.origin) return no(403, "wrong origin");
      if (!socket && h.get("x-shepherdr") !== "1") return no(403, "missing x-shepherdr");
    }
    this.passes.set(req, { ok: true, who: `device:${device.name}`, via: "proxy", device });
    return next(req, srv);
  }

  private async devicesRoute(req: Request, me: Shown) {
    if (req.method === "GET") return page(devicesPage(this.devices.list(), me.id));
    if (req.method !== "POST") return no(405, "GET or POST");
    if (!this.sameOrigin(req)) return no(403, "from this site's own page");
    const form = await req.formData().catch(() => null);
    const act = String(form?.get("action") ?? "");
    if (act === "code") return page(devicesPage(this.devices.list(), me.id, this.devices.mint()));
    if (act === "revoke") {
      const id = String(form?.get("id") ?? "");
      this.devices.revoke(id);
      if (id === me.id) return new Response(null, { status: 303, headers: { location: "/shepherdr/pair", "cache-control": "no-store",
        "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/shepherdr; Max-Age=0` } });
      return new Response(null, { status: 303, headers: { location: "/shepherdr/devices", "cache-control": "no-store" } });
    }
    return no(400, "unknown action");
  }

  /** /api/proxy/* for this machine's own callers (the CLI, with the token on 127.0.0.1): mint a code, list, revoke.
   *  null: not one of these routes. */
  async api(req: Request, pass: Pass): Promise<Response | null> {
    const path = strip(new URL(req.url).pathname);
    if (!/^\/api\/proxy(\/|$)/.test(path)) return null;
    if (!pass.ok || pass.via !== "local") return json({ error: "only on this machine" }, 403);
    if (path === "/api/proxy/status") return json({ on: !!this.conf, origin: this.origin, link: this.link, bind: this.conf?.bind ?? null, port: this.conf?.port ?? null });
    if (path === "/api/proxy/devices" && req.method === "GET") return json({ devices: this.devices.list() });
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    const body: any = await req.json().catch(() => ({}));
    if (path === "/api/proxy/pair") {
      if (!this.conf) return json({ error: "proxy mode is off: shepherdr web proxy setup, then restart the service" }, 409);
      const { code, expires } = this.devices.mint();
      this.log(`proxy: a pairing code was made${body?.name ? ` for ${cleanName(body.name)}` : ""}`);
      return json({ code, expires, link: `${this.conf.origin}/shepherdr/pair` });
    }
    if (path === "/api/proxy/revoke") return this.devices.revoke(body?.id) ? json({ ok: true }) : json({ error: "no such device" }, 404);
    return json({ error: "not found" }, 404);
  }

  /** The main server's options, unchanged; with proxy mode on, a second listener on bind:port with the same app. */
  listen<T>(opts: T): T {
    const c = this.conf, o = opts as any;
    if (!c) return opts;
    // the address may not be there yet (a Docker bridge at boot): tried again every 30 s until it is
    let said = "";
    const start = () => {
      try {
        const s = Bun.serve({ hostname: c.bind, port: c.port, idleTimeout: o.idleTimeout, websocket: o.websocket,
          fetch: (req: Request, srv: any) => this.front(req, srv, (r, sv) => o.fetch.call(sv, r, sv)) } as any);
        this.server = s;
        this.log(`proxy: the web app on http://${c.bind.includes(":") ? `[${c.bind}]` : c.bind}:${s.port} for ${c.origin}`);
      } catch (e) {
        const why = `proxy: can't listen on ${c.bind}:${c.port}: ${(e as Error).message}; trying again every 30 s`;
        if (why !== said) console.error((said = why));
        this.retry = setTimeout(start, RETRY);
        (this.retry as any).unref?.();
      }
    };
    start();
    return opts;
  }
  /** Stops the listener and any retry (tests). */
  stop() { if (this.retry) clearTimeout(this.retry); this.retry = null; this.server?.stop(true); this.server = null; }
  private retry: ReturnType<typeof setTimeout> | null = null;
  server: ReturnType<typeof Bun.serve> | null = null;
}

// This service's one proxy, read from proxy.json at its first use (the service reads it once a start).
let current: Proxy | null = null;
export const proxy = () => (current ??= new Proxy(readConf(), new Devices()));
/** Tests: another proxy in its place. */
export function useProxy(p: Proxy | null) { current = p; }

export const withProxy = <T>(opts: T): T => proxy().listen(opts);
export const proxyPass = (req: Request) => proxy().pass(req);
export const proxied = (req: Request) => proxy().proxied(req);
export const proxyDevice = (req: Request) => proxy().device(req);
export const proxyOrigin = () => proxy().origin;
export const proxyLink = () => proxy().link;
export const proxyApi = (req: Request, pass: Pass) => proxy().api(req, pass);
/** The push alerts' subject (VAPID): the proxy's origin when it is on, else the tailnet's (main.ts). */
export const pushOrigin = (tailnet: () => string) => () => proxyOrigin() ?? tailnet();
