// The devices paired with the web app through a trusted reverse proxy (proxy.ts; this fork's own, FORK.md). A device
// pairs once with a one-time code and then carries a long-lived cookie; each one can be revoked on its own.
// - A code: 6 characters from 31 that can't be mixed up (no I, L, O, 0, 1), single use, 5 minutes, kept in memory
//   only. 10 wrong tries within 5 minutes void every open code (someone is guessing); a new one is minted again.
// - A cookie: 32 random bytes; only its SHA-256 is kept, in devices.json in the service's folder (0600, written whole
//   and renamed into place). A device's last visit is written at most once an hour.
// Codes and cookies are never logged; the code is shown once, to whoever minted it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./paths.ts";

export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_TTL = 5 * 60_000;
export const MAX_WRONG = 10;
export const SEEN_EVERY = 60 * 60_000;

export type Device = { id: string; name: string; hash: string; created: number; lastSeen: number; revoked: boolean };
/** A device as shown (the CLI, the devices page): never its hash. */
export type Shown = Omit<Device, "hash">;

const hashOf = (cookie: string) => createHash("sha256").update(cookie).digest("hex");
const shown = ({ hash: _h, ...d }: Device): Shown => d;

/** A device's name as typed: printable, trimmed, at most 40 characters ("device" when empty). */
export function cleanName(name: unknown) {
  const s = String(name ?? "").replace(/[\u0000-\u001f\u007f<>&"'`]/g, "").trim().slice(0, 40);
  return s || "device";
}

export class Devices {
  private codes = new Map<string, number>();   // code → when it stops working
  private wrong: number[] = [];                // when each recent wrong try was
  private list_: Device[];

  constructor(readonly file = join(DATA, "devices.json"), private now = () => Date.now(), private log = (s: string) => console.log(s)) {
    this.list_ = this.read();
  }

  /** devices.json as written; anything else (missing, broken, hand-edited into another shape) is no devices. */
  private read(): Device[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter((d: any) => d && typeof d.id === "string" && typeof d.name === "string" && /^[0-9a-f]{64}$/.test(d.hash ?? "")
        && typeof d.created === "number" && typeof d.lastSeen === "number" && typeof d.revoked === "boolean");
    } catch { return []; }
  }

  private write() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list_, null, 1) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** A new one-time code (the CLI's `web pair`, or the devices page of a paired device). */
  mint(): { code: string; expires: number } {
    const at = this.now();
    for (const [c, until] of this.codes) if (until <= at) this.codes.delete(c);
    const bytes = randomBytes(6);
    const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    this.codes.set(code, at + CODE_TTL);
    return { code, expires: at + CODE_TTL };
  }

  /** Pair with a code: the new device's cookie (to set once) and its record, or why not. */
  pair(code: unknown, name: unknown): { ok: true; cookie: string; device: Shown } | { ok: false; why: string } {
    const at = this.now();
    const given = String(code ?? "").toUpperCase().replace(/[\s-]/g, "");
    const until = this.codes.get(given);
    if (until === undefined || until <= at) {
      if (until !== undefined) this.codes.delete(given);
      this.wrong = this.wrong.filter((t) => at - t < CODE_TTL);
      this.wrong.push(at);
      if (this.wrong.length >= MAX_WRONG && this.codes.size) {
        this.codes.clear();
        this.log(`proxy: ${this.wrong.length} wrong pairing codes in 5 minutes; every open code is void`);
      }
      return { ok: false, why: "That code is wrong or has expired." };
    }
    this.codes.delete(given);
    const cookie = randomBytes(32).toString("base64url");
    const d: Device = { id: randomBytes(4).toString("hex"), name: cleanName(name), hash: hashOf(cookie), created: at, lastSeen: at, revoked: false };
    this.list_.push(d);
    this.write();
    this.log(`proxy: paired device ${d.name} (${d.id})`);
    return { ok: true, cookie, device: shown(d) };
  }

  /** The paired, not revoked device a cookie belongs to, or null. Notes its visit (at most once an hour). */
  check(cookie: string | null | undefined): Shown | null {
    if (!cookie || cookie.length > 200) return null;
    const h = Buffer.from(hashOf(cookie), "hex");
    let hit: Device | null = null;
    for (const d of this.list_) if (timingSafeEqual(h, Buffer.from(d.hash, "hex")) && !d.revoked) hit = d;
    if (!hit) return null;
    const at = this.now();
    if (at - hit.lastSeen >= SEEN_EVERY) { hit.lastSeen = at; try { this.write(); } catch {} }
    return shown(hit);
  }

  list(): Shown[] { return this.list_.map(shown); }

  /** Revoke a device: its cookie stops working at once. */
  revoke(id: unknown): boolean {
    const d = this.list_.find((x) => x.id === id && !x.revoked);
    if (!d) return false;
    d.revoked = true;
    this.write();
    this.log(`proxy: revoked device ${d.name} (${d.id})`);
    return true;
  }

  /** Open codes now (tests). */
  openCodes() { const at = this.now(); return [...this.codes.values()].filter((u) => u > at).length; }
}
