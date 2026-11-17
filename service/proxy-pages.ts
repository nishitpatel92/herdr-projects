// Proxy mode's two pages (proxy.ts; this fork's own, FORK.md), made here as plain HTML so the web app needs no change:
// pairing a device with a one-time code, and the paired devices (revoke one, make a code for another device).
// Every form posts to the same page on the same origin; the page has no script.
import type { Shown } from "./devices.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>
body{font:16px/1.45 system-ui,-apple-system,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem}
input,button{font:inherit;padding:.6rem .7rem;border-radius:.5rem;border:1px solid #8888;width:100%;box-sizing:border-box;margin:.25rem 0 .8rem}
button{cursor:pointer}.code{font:600 2rem ui-monospace,monospace;letter-spacing:.2em}.err{color:#c33}.muted{opacity:.7;font-size:.9em}
table{width:100%;border-collapse:collapse}td{padding:.4rem 0;border-top:1px solid #8884;vertical-align:top}td form button{width:auto;margin:0}
</style></head><body>${body}</body></html>`;
}

export function pairPage(error?: string) {
  return shell("Pair this device", `<h1>Pair this device</h1>
<p>Get a code on the machine that runs Shepherdr (<code>shepherdr web pair</code>) or from a device already paired
(its <code>/shepherdr/devices</code> page). A code works once, for 5 minutes.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/shepherdr/pair">
<label>Code<input name="code" autocomplete="one-time-code" autocapitalize="characters" inputmode="text" maxlength="12" required autofocus></label>
<label>This device's name<input name="name" maxlength="40" placeholder="Phone"></label>
<button type="submit">Pair</button></form>`);
}

export function devicesPage(list: Shown[], me: string, minted?: { code: string; expires: number }) {
  const rows = list.filter((d) => !d.revoked).map((d) => `<tr><td>${esc(d.name)}${d.id === me ? " <span class=muted>(this one)</span>" : ""}
<div class="muted">paired ${when(d.created)}, last seen ${when(d.lastSeen)}</div></td>
<td><form method="post" action="/shepherdr/devices"><input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${esc(d.id)}">
<button type="submit">Revoke</button></form></td></tr>`).join("");
  return shell("Paired devices", `<h1>Paired devices</h1>
${minted ? `<p>Code for the new device, for 5 minutes:</p><p class="code">${esc(minted.code)}</p>` : ""}
<form method="post" action="/shepherdr/devices"><input type="hidden" name="action" value="code"><button type="submit">Pair another device</button></form>
<table>${rows}</table><p><a href="/shepherdr/">Back to Shepherdr</a></p>`);
}
