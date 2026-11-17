import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPHABET, CODE_TTL, Devices, MAX_WRONG, SEEN_EVERY, cleanName } from "./devices.ts";

const setup = () => {
  const file = join(mkdtempSync(join(tmpdir(), "shep-devices-")), "devices.json");
  let now = 1_000_000;
  const logs: string[] = [];
  const d = new Devices(file, () => now, (s) => logs.push(s));
  return { d, file, logs, tick: (ms: number) => { now += ms; }, at: () => now };
};

describe("pairing codes", () => {
  test("a code is 6 characters that can't be mixed up", () => {
    const { d } = setup();
    expect(ALPHABET.length).toBe(31);
    for (let i = 0; i < 50; i++) expect(d.mint().code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  });
  test("a code works once", () => {
    const { d } = setup();
    const { code } = d.mint();
    expect(d.pair(code, "Phone")).toMatchObject({ ok: true, device: { name: "Phone", revoked: false } });
    expect(d.pair(code, "Phone again")).toMatchObject({ ok: false });
  });
  test("typed in lower case or with a space it still works", () => {
    const { d } = setup();
    const { code } = d.mint();
    expect(d.pair(` ${code.slice(0, 3).toLowerCase()} ${code.slice(3)} `, "x")).toMatchObject({ ok: true });
  });
  test("a code expires after 5 minutes", () => {
    const { d, tick } = setup();
    const { code } = d.mint();
    tick(CODE_TTL);
    expect(d.pair(code, "late")).toMatchObject({ ok: false });
  });
  test("too many wrong tries void every open code", () => {
    const { d, logs } = setup();
    const { code } = d.mint();
    for (let i = 0; i < MAX_WRONG; i++) expect(d.pair("WRONG" + i, "x").ok).toBe(false);
    expect(d.openCodes()).toBe(0);
    expect(d.pair(code, "the 11th try")).toMatchObject({ ok: false });
    expect(logs.join("\n")).toContain(`${MAX_WRONG} wrong pairing codes in 5 minutes; every open code is void`);
    expect(logs.join("\n")).not.toContain(code);
  });
  test("after codes are voided the count starts again: one wrong try doesn't void the next code", () => {
    const { d } = setup();
    d.mint();
    for (let i = 0; i < MAX_WRONG; i++) d.pair("WRONG" + i, "x");
    const fresh = d.mint().code;
    d.pair("TYPO", "x");
    expect(d.pair(fresh, "x").ok).toBe(true);
  });
  test("wrong tries spread over more than 5 minutes don't add up", () => {
    const { d, tick } = setup();
    for (let i = 0; i < MAX_WRONG - 1; i++) d.pair("NOPE", "x");
    tick(CODE_TTL);   // the old tries are not counted any more
    const fresh = d.mint().code;
    d.pair("NOPE", "x");
    expect(d.pair(fresh, "x").ok).toBe(true);
  });
});

describe("device cookies", () => {
  test("only the cookie's hash is kept, in a file only this user can read", () => {
    const { d, file } = setup();
    const r = d.pair(d.mint().code, "Phone");
    if (!r.ok) throw new Error(r.why);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(r.cookie);
    expect(JSON.parse(text)[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(r.cookie, "base64url").length).toBe(32);
  });
  test("the cookie lets its device in, a made-up one doesn't", () => {
    const { d } = setup();
    const r = d.pair(d.mint().code, "Phone");
    if (!r.ok) throw new Error(r.why);
    expect(d.check(r.cookie)).toMatchObject({ id: r.device.id, name: "Phone" });
    expect(d.check("x".repeat(43))).toBeNull();
    expect(d.check("")).toBeNull();
    expect(d.check(null)).toBeNull();
  });
  test("revoking stops a cookie at once, and survives a restart", () => {
    const { d, file } = setup();
    const r = d.pair(d.mint().code, "Phone");
    if (!r.ok) throw new Error(r.why);
    expect(d.revoke(r.device.id)).toBe(true);
    expect(d.check(r.cookie)).toBeNull();
    expect(new Devices(file).check(r.cookie)).toBeNull();
    expect(d.revoke(r.device.id)).toBe(false);
  });
  test("a paired device is still paired after a restart", () => {
    const { d, file } = setup();
    const r = d.pair(d.mint().code, "Phone");
    if (!r.ok) throw new Error(r.why);
    expect(new Devices(file).check(r.cookie)).toMatchObject({ name: "Phone" });
  });
  test("the last visit is written at most once an hour", () => {
    const { d, file, tick, at } = setup();
    const r = d.pair(d.mint().code, "Phone");
    if (!r.ok) throw new Error(r.why);
    const first = at();
    tick(SEEN_EVERY - 1);
    d.check(r.cookie);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].lastSeen).toBe(first);
    tick(1);
    d.check(r.cookie);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].lastSeen).toBe(at());
  });
  test("a tampered devices.json is read as no devices, not a crash", () => {
    const { file } = setup();
    for (const bad of ["{not json", "{\"a\":1}", "[{\"id\":1}]", "[null]", ""]) {
      writeFileSync(file, bad);
      expect(new Devices(file).list()).toEqual([]);
    }
  });
  test("the list never shows a hash", () => {
    const { d } = setup();
    d.pair(d.mint().code, "Phone");
    expect(Object.keys(d.list()[0])).not.toContain("hash");
  });
  test("a device's name is cleaned", () => {
    expect(cleanName("  <b>Phone</b>\n ")).toBe("bPhone/b");
    expect(cleanName("")).toBe("device");
    expect(cleanName("x".repeat(99)).length).toBe(40);
  });
});
