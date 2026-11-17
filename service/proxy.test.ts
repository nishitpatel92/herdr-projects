import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, type Gate, type Pass } from "./auth.ts";
import { Devices } from "./devices.ts";
import { COOKIE, Proxy, parseConf, proxyOrigin, pushOrigin, readConf, useProxy } from "./proxy.ts";

const ORIGIN = "https://shepherdr.blackbox";
const conf = parseConf({ bind: "127.0.0.1", port: 7789, origin: ORIGIN });
if (!conf.ok) throw new Error(conf.why);
const tmp = () => mkdtempSync(join(tmpdir(), "shep-proxy-"));
const quiet = () => {};

function setup() {
  const devices = new Devices(join(tmp(), "devices.json"), () => Date.now(), quiet);
  const p = new Proxy(conf.ok ? conf.conf : null, devices, quiet);
  const seen: Request[] = [];
  const next = (req: Request) => { seen.push(req); return new Response("app"); };
  const paired = () => { const r = devices.pair(devices.mint().code, "Phone"); if (!r.ok) throw new Error(r.why); return r; };
  const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}) =>
    new Request(`http://shepherdr.blackbox${path}`, { method: init.method ?? "GET", body: init.body, headers: { host: "shepherdr.blackbox", ...init.headers } });
  const send = (r: Request) => p.front(r, null, next);
  return { p, devices, seen, paired, req, send };
}
const withCookie = (c: string, h: Record<string, string> = {}) => ({ cookie: `${COOKIE}=${c}`, ...h });
const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };

describe("proxy.json", () => {
  test("missing or invalid: the mode is off", () => {
    const d = tmp();
    expect(readConf(join(d, "proxy.json"), quiet)).toBeNull();
    writeFileSync(join(d, "proxy.json"), "{nope");
    expect(readConf(join(d, "proxy.json"), quiet)).toBeNull();
    writeFileSync(join(d, "proxy.json"), JSON.stringify({ bind: "shepherdr.blackbox", origin: ORIGIN }));
    expect(readConf(join(d, "proxy.json"), quiet)).toBeNull();
  });
  test("every interface is refused", () => {
    for (const bind of ["0.0.0.0", "::", "::0"]) expect(parseConf({ bind, origin: ORIGIN })).toMatchObject({ ok: false });
  });
  test("the origin is https and nothing after the name", () => {
    for (const origin of ["http://shepherdr.blackbox", "https://shepherdr.blackbox/shepherdr", "https://u@shepherdr.blackbox", "nope"])
      expect(parseConf({ bind: "172.30.172.1", origin })).toMatchObject({ ok: false });
    expect(parseConf({ bind: "172.30.172.1", origin: "https://shepherdr.blackbox:8443/" }))
      .toMatchObject({ ok: true, conf: { bind: "172.30.172.1", port: 7789, origin: "https://shepherdr.blackbox:8443", host: "shepherdr.blackbox:8443" } });
  });
  test("a good file is read", () => {
    const d = tmp();
    writeFileSync(join(d, "proxy.json"), JSON.stringify({ bind: "172.30.172.1", port: 7790, origin: ORIGIN }));
    expect(readConf(join(d, "proxy.json"), quiet)).toEqual({ bind: "172.30.172.1", port: 7790, origin: ORIGIN, host: "shepherdr.blackbox" });
  });
});

describe("without a paired device", () => {
  test("a page gets the pairing page, the API and a socket get 401", async () => {
    const { send, req, seen } = setup();
    const pageR = await send(req("/shepherdr/", { headers: NAV }));
    expect(pageR?.status).toBe(401);
    expect(await pageR?.text()).toContain("Pair this device");
    expect((await send(req("/shepherdr/api/state")))?.status).toBe(401);
    expect((await send(req("/shepherdr/api/ws", { headers: { upgrade: "websocket", origin: ORIGIN } })))?.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
  test("a made-up or revoked cookie gets nothing", async () => {
    const { send, req, devices, paired, seen } = setup();
    expect((await send(req("/shepherdr/api/state", { headers: withCookie("x".repeat(43)) })))?.status).toBe(401);
    const r = paired();
    devices.revoke(r.device.id);
    expect((await send(req("/shepherdr/api/state", { headers: withCookie(r.cookie) })))?.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
  test("Tailscale's login header or the real local token through the proxy grant nothing", async () => {
    const { send, req, seen, p } = setup();
    const r = req("/shepherdr/api/me", { headers: { "tailscale-user-login": "me@example.com", authorization: "Bearer secret-token" } });
    expect((await send(r))?.status).toBe(401);
    expect(r.headers.has("tailscale-user-login")).toBe(false);
    expect(r.headers.has("authorization")).toBe(false);
    expect(p.pass(r)).toBeNull();
    expect(seen).toHaveLength(0);
    // and gate() itself, handed what reaches the app, would refuse it too
    const g: Gate = { owner: "me@example.com", dns: "box.tailnet.example", port: 7788, token: "secret-token" };
    expect(gate(r, g, false, true)).toMatchObject({ ok: false });
  });
});

describe("pairing", () => {
  test("a code from the CLI pairs the device and sets its cookie", async () => {
    const { send, req, devices } = setup();
    const { code } = devices.mint();
    const r = await send(req("/shepherdr/pair", { method: "POST", body: new URLSearchParams({ code, name: "Phone" }),
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" } }));
    expect(r?.status).toBe(303);
    const cookie = r?.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=/shepherdr; Max-Age=34560000$`));
    expect(devices.list()).toMatchObject([{ name: "Phone" }]);
  });
  test("a pair post from another site, or without Sec-Fetch-Site, is refused", async () => {
    const { send, req, devices } = setup();
    const { code } = devices.mint();
    const post = (h: Record<string, string>) => send(req("/shepherdr/pair", { method: "POST", body: new URLSearchParams({ code }),
      headers: { "content-type": "application/x-www-form-urlencoded", ...h } }));
    expect((await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect((await post({ origin: ORIGIN }))?.status).toBe(403);
    expect((await post({ "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    expect(devices.list()).toHaveLength(0);
  });
  test("a wrong code says so and pairs nothing", async () => {
    const { send, req, devices } = setup();
    const r = await send(req("/shepherdr/pair", { method: "POST", body: new URLSearchParams({ code: "AAAAAA" }),
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" } }));
    expect(r?.status).toBe(403);
    expect(r?.headers.has("set-cookie")).toBe(false);
    expect(devices.list()).toHaveLength(0);
  });
});

describe("with a paired device", () => {
  test("a read passes as the device, via proxy", async () => {
    const { send, req, paired, seen, p } = setup();
    const { cookie, device } = paired();
    const r = req("/shepherdr/api/state", { headers: withCookie(cookie) });
    expect(await (await send(r))?.text()).toBe("app");
    expect(seen).toEqual([r]);
    expect(p.pass(r)).toMatchObject({ ok: true, via: "proxy", who: "device:Phone" });
    expect(p.proxied(r)).toBe(true);
    expect(p.device(r)).toBe(`proxy:${device.id}`);
  });
  test("another host name is refused (DNS rebinding)", async () => {
    const { send, req, paired } = setup();
    const { cookie } = paired();
    expect((await send(req("/shepherdr/api/state", { headers: withCookie(cookie, { host: "evil.example" }) })))?.status).toBe(421);
  });
  test("a write needs the page's own origin and x-shepherdr", async () => {
    const { send, req, paired, seen } = setup();
    const { cookie } = paired();
    const post = (h: Record<string, string>) => send(req("/shepherdr/api/action", { method: "POST", body: "{}", headers: withCookie(cookie, h) }));
    expect((await post({ "x-shepherdr": "1" }))?.status).toBe(403);
    expect((await post({ origin: "https://evil.example", "x-shepherdr": "1" }))?.status).toBe(403);
    expect((await post({ origin: ORIGIN }))?.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(await (await post({ origin: ORIGIN, "x-shepherdr": "1" }))?.text()).toBe("app");
  });
  test("a socket needs the page's own origin", async () => {
    const { send, req, paired, seen } = setup();
    const { cookie } = paired();
    expect((await send(req("/shepherdr/api/ws", { headers: withCookie(cookie, { upgrade: "websocket", origin: "https://evil.example" }) })))?.status).toBe(403);
    expect((await send(req("/shepherdr/api/ws", { headers: withCookie(cookie, { upgrade: "websocket" }) })))?.status).toBe(403);
    expect(await (await send(req("/shepherdr/api/ws", { headers: withCookie(cookie, { upgrade: "websocket", origin: ORIGIN }) })))?.text()).toBe("app");
    expect(seen).toHaveLength(1);
  });
  test("a cross-site fetch is refused; a link from another site to the page opens it", async () => {
    const { send, req, paired } = setup();
    const { cookie } = paired();
    expect((await send(req("/shepherdr/api/state", { headers: withCookie(cookie, { "sec-fetch-site": "cross-site" }) })))?.status).toBe(403);
    expect((await send(req("/shepherdr/", { headers: withCookie(cookie, { ...NAV, "sec-fetch-site": "cross-site" }) })))?.status).toBe(200);
    expect((await send(req("/shepherdr/api/state", { method: "OPTIONS", headers: withCookie(cookie) })))?.status).toBe(403);
    // a sibling *.blackbox site is same-site: its fetches are refused too, a link to the page still opens it
    expect((await send(req("/shepherdr/api/state", { headers: withCookie(cookie, { "sec-fetch-site": "same-site" }) })))?.status).toBe(403);
    expect((await send(req("/shepherdr/", { headers: withCookie(cookie, { ...NAV, "sec-fetch-site": "same-site" }) })))?.status).toBe(200);
  });
  test("/ goes to /shepherdr/", async () => {
    const { send, req } = setup();
    const r = await send(req("/"));
    expect(r?.status).toBe(302);
    expect(r?.headers.get("location")).toBe(`${ORIGIN}/shepherdr/`);
  });
  test("/api/proxy is refused through the proxy, even with a cookie", async () => {
    const { send, req, paired, seen } = setup();
    const { cookie } = paired();
    expect((await send(req("/shepherdr/api/proxy/pair", { method: "POST", headers: withCookie(cookie, { origin: ORIGIN, "x-shepherdr": "1" }) })))?.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
  test("the devices page lists, makes a code and revokes", async () => {
    const { send, req, paired, devices } = setup();
    const a = paired(), b = paired();
    const list = await send(req("/shepherdr/devices", { headers: withCookie(a.cookie, NAV) }));
    expect(await list?.text()).toContain("(this one)");
    const form = (body: Record<string, string>, h: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) =>
      send(req("/shepherdr/devices", { method: "POST", body: new URLSearchParams(body), headers: withCookie(a.cookie, { "content-type": "application/x-www-form-urlencoded", ...h }) }));
    expect((await form({ action: "code" }))?.status).toBe(200);
    expect(devices.openCodes()).toBe(1);
    expect((await form({ action: "revoke", id: b.device.id }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(devices.check(b.cookie)).not.toBeNull();
    expect((await form({ action: "revoke", id: b.device.id }))?.status).toBe(303);
    expect(devices.check(b.cookie)).toBeNull();
    const self = await form({ action: "revoke", id: a.device.id });
    expect(self?.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(devices.check(a.cookie)).toBeNull();
  });
});

describe("/api/proxy for this machine's own callers", () => {
  const local: Pass = { ok: true, who: "local", via: "local" };
  const tailnet: Pass = { ok: true, who: "me@example.com", via: "tailnet" };
  const at = (path: string, method = "GET", body?: unknown) =>
    new Request(`http://127.0.0.1:7788${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  test("only a local caller (the CLI with the token) mints, lists and revokes", async () => {
    const { p, devices } = setup();
    expect((await p.api(at("/api/proxy/pair", "POST", {}), tailnet))?.status).toBe(403);
    const minted = await (await p.api(at("/api/proxy/pair", "POST", { name: "Phone" }), local))!.json();
    expect(minted.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(minted.link).toBe(`${ORIGIN}/shepherdr/pair`);
    const r = devices.pair(minted.code, "Phone");
    if (!r.ok) throw new Error(r.why);
    expect((await (await p.api(at("/shepherdr/api/proxy/devices"), local))!.json()).devices).toMatchObject([{ name: "Phone" }]);
    expect((await p.api(at("/api/proxy/revoke", "POST", { id: r.device.id }), local))?.status).toBe(200);
    expect(devices.check(r.cookie)).toBeNull();
    expect((await p.api(at("/api/proxy/revoke", "POST", { id: "nope" }), local))?.status).toBe(404);
  });
  test("other routes are not its own", async () => {
    const { p } = setup();
    expect(await p.api(at("/api/state"), local)).toBeNull();
  });
  test("with proxy mode off there is no code to make", async () => {
    const off = new Proxy(null, new Devices(join(tmp(), "devices.json"), undefined, quiet), quiet);
    expect((await off.api(at("/api/proxy/pair", "POST", {}), local))?.status).toBe(409);
    expect(off.listen({ x: 1 })).toEqual({ x: 1 });
    expect(off.server).toBeNull();
  });
});

describe("push alerts", () => {
  test("their subject is the proxy's origin when it is on, else the tailnet's", () => {
    const subject = pushOrigin(() => "https://box.tailnet.example");
    try {
      useProxy(new Proxy(null, new Devices(join(tmp(), "devices.json"), undefined, quiet), quiet));
      expect(subject()).toBe("https://box.tailnet.example");
      expect(proxyOrigin()).toBeNull();
      useProxy(new Proxy(conf.ok ? conf.conf : null, new Devices(join(tmp(), "devices.json"), undefined, quiet), quiet));
      expect(subject()).toBe(ORIGIN);
    } finally { useProxy(null); }
  });
});
