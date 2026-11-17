// Proxy mode end to end, over real HTTP: a stand-in for main.ts's server (the same gate, proxyPass and proxyApi lines)
// on 127.0.0.1, wrapped by Proxy.listen, which opens the proxy listener on another port of 127.0.0.1 here.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, type Gate } from "./auth.ts";
import { Devices } from "./devices.ts";
import { COOKIE, Proxy } from "./proxy.ts";

const ORIGIN = "https://shepherdr.blackbox";
const quiet = () => {};
const devices = new Devices(join(mkdtempSync(join(tmpdir(), "shep-e2e-")), "devices.json"), undefined, quiet);
const p = new Proxy({ bind: "127.0.0.1", port: 0, origin: ORIGIN, host: "shepherdr.blackbox" }, devices, quiet);
const g: Gate = { owner: null, dns: null, port: 0, token: "local-token" };

const main = Bun.serve<{ who: string }>(p.listen({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, srv) {
    const path = new URL(req.url).pathname.replace(/^\/shepherdr(?=\/)/, "");
    const socket = path === "/api/ws";
    const pass = p.pass(req) ?? gate(req, g, socket);
    if (!pass.ok) return new Response(pass.why, { status: pass.status });
    { const r = await p.api(req, pass); if (r) return r; }
    if (socket) return srv.upgrade(req, { data: { who: pass.who } }) ? undefined : new Response("upgrade failed", { status: 400 });
    if (path === "/api/me") return Response.json({ login: pass.who, via: pass.via });
    return new Response("not found", { status: 404 });
  },
  websocket: { open(ws) { ws.send(`hello ${ws.data.who}`); }, message() {} },
}));
g.port = main.port!;
const proxyPort = p.server!.port;
afterAll(() => { main.stop(true); p.stop(); });

const local = (path: string, method = "GET") =>
  fetch(`http://127.0.0.1:${main.port}${path}`, { method, headers: { authorization: "Bearer local-token" } });
const viaProxy = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${proxyPort}${path}`, { redirect: "manual", ...init, headers: { host: "shepherdr.blackbox", ...headers } });

test("pair with a code from the CLI route, then use the cookie over HTTP and a socket", async () => {
  // no cookie: nothing
  expect((await viaProxy("/shepherdr/api/me")).status).toBe(401);
  // the CLI's route answers only on 127.0.0.1 with the token, never through the proxy
  expect((await viaProxy("/shepherdr/api/proxy/pair", { authorization: "Bearer local-token" }, { method: "POST" })).status).toBe(401);
  const minted = await (await local("/api/proxy/pair", "POST")).json();
  expect(minted.code).toMatch(/^[A-Z2-9]{6}$/);

  const paired = await viaProxy("/shepherdr/pair", { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    { method: "POST", body: new URLSearchParams({ code: minted.code, name: "Phone" }).toString() });
  expect(paired.status).toBe(303);
  const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie.startsWith(`${COOKIE}=`)).toBe(true);

  const me = await viaProxy("/shepherdr/api/me", { cookie });
  expect(await me.json()).toEqual({ login: "device:Phone", via: "proxy" });

  // the socket, with the page's origin
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/shepherdr/api/ws`, { headers: { host: "shepherdr.blackbox", origin: ORIGIN, cookie } } as any);
  const first = await new Promise<string>((ok, bad) => { ws.onmessage = (e) => ok(String(e.data)); ws.onerror = () => bad(new Error("socket failed")); });
  ws.close();
  expect(first).toBe("hello device:Phone");

  // the local listener is unchanged: the token still works there, a cookie alone doesn't
  expect(await (await local("/api/me")).json()).toEqual({ login: "local", via: "local" });
  expect((await fetch(`http://127.0.0.1:${main.port}/api/me`, { headers: { cookie } })).status).toBe(401);

  // listed and revoked through the CLI's routes; the cookie stops at once
  const listed = await (await local("/api/proxy/devices")).json();
  expect(listed.devices).toMatchObject([{ name: "Phone", revoked: false }]);
  const revoke = await fetch(`http://127.0.0.1:${main.port}/api/proxy/revoke`, { method: "POST", headers: { authorization: "Bearer local-token" }, body: JSON.stringify({ id: listed.devices[0].id }) });
  expect(revoke.status).toBe(200);
  expect((await viaProxy("/shepherdr/api/me", { cookie })).status).toBe(401);
});
