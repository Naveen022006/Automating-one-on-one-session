import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EncryptedAuthState, openAuthBlob } from "../lib/whatsapp-web/auth-state";
import { kvKeys } from "../lib/whatsapp-web/kv";
import { contactsIn, digitsOf, jidUser, keyOwner, pruneAllExcept, pruneContacts, type KeyTables } from "../lib/whatsapp-web/prune";
import { PRUNE_ALL_EVERY_MS, PRUNE_REQUESTS_EVERY_MS } from "../worker/whatsapp-web-manager";
import { parsePruneRequests, PRUNE_REQUEST_TTL_MS } from "../lib/whatsapp-web/prune-requests";
import { harness, settle, want } from "./helpers/whatsapp-web";

// Customers' phone numbers live in the NAMES of the per-contact keys of a stored login. These tests run the clean-up on a synthetic key
// table (the library's naming is isolated in lib/whatsapp-web/prune.ts and pinned by the last test) and through the manager.

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

const A_PN = "919876500101";
const A_LID = "123456789012345";
const B_PN = "919876500102";
const B_LID = "999000111222333";
const C_PN = "919876500103"; // a stranger: no booking any more
const OWN_PN = "919876500001";
const OWN_LID = "555500001111";

const token = (jids: string[]) => ({ token: Buffer.from(JSON.stringify(jids)) });

function tables(): KeyTables {
  return {
    "pre-key": { "1": { pub: Buffer.from("x") }, "2": { pub: Buffer.from("y") } },
    "app-state-sync-key": { AAAA: { keyData: Buffer.from("k") } },
    "sender-key": { [`1203630000000000@g.us::${A_PN}::0`]: Buffer.from("group sender key") },
    session: {
      [`${A_PN}.0`]: "sess-a0",
      [`${A_PN}.3`]: "sess-a3",
      [`${A_LID}_1.0`]: "sess-a-lid",
      [`${B_PN}.0`]: "sess-b0",
      [`${B_LID}_1.2`]: "sess-b-lid",
      [`${C_PN}.0`]: "sess-c0",
      [`${OWN_PN}.0`]: "sess-own",
      [`${OWN_LID}_1.0`]: "sess-own-lid",
    },
    "device-list": { [A_PN]: ["0", "3"], [B_PN]: ["0"], [C_PN]: ["0"], [OWN_PN]: ["0", "12"] },
    "lid-mapping": {
      [A_PN]: A_LID,
      [`${A_LID}_reverse`]: A_PN,
      [B_PN]: B_LID,
      [`${B_LID}_reverse`]: B_PN,
      [OWN_PN]: OWN_LID,
      [`${OWN_LID}_reverse`]: OWN_PN,
    },
    tctoken: {
      [`${A_PN}@s.whatsapp.net`]: { token: Buffer.from("t1"), timestamp: "1" },
      [`${A_LID}@lid`]: { token: Buffer.from("t2"), timestamp: "1" },
      [`${B_PN}@s.whatsapp.net`]: { token: Buffer.from("t3"), timestamp: "1" },
      __index: token([`${A_PN}@s.whatsapp.net`, `${A_LID}@lid`, `${B_PN}@s.whatsapp.net`]),
    },
  };
}

const ids = (keys: KeyTables, type: string) => Object.keys(keys[type] ?? {}).sort();
const everythingText = (keys: KeyTables) => JSON.stringify(keys, (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString() : v));

test("the naming patterns: which key ids belong to a contact", () => {
  assert.equal(keyOwner("session", "919876500101.0"), "919876500101");
  assert.equal(keyOwner("session", "123456789012345_1.12"), "123456789012345");
  assert.equal(keyOwner("session", "garbage"), null);
  assert.equal(keyOwner("device-list", "919876500101"), "919876500101");
  assert.equal(keyOwner("device-list", "919876500101:3"), null);
  assert.equal(keyOwner("lid-mapping", "919876500101"), "919876500101");
  assert.equal(keyOwner("lid-mapping", "123456789012345_reverse"), "123456789012345");
  assert.equal(keyOwner("tctoken", "919876500101@s.whatsapp.net"), "919876500101");
  assert.equal(keyOwner("tctoken", "123456789012345@lid"), "123456789012345");
  assert.equal(keyOwner("tctoken", "__index"), null);
  for (const own of ["pre-key", "app-state-sync-key", "sender-key", "sender-key-memory", "app-state-sync-version"]) assert.equal(keyOwner(own, "919876500101"), null, `${own} is never a contact table`);
  assert.equal(digitsOf("+91 98765 00101"), "919876500101");
  assert.equal(jidUser("919876500001:12@s.whatsapp.net"), "919876500001");
  assert.equal(jidUser("555500001111@lid"), "555500001111");
  assert.equal(jidUser(undefined), null);
});

test("erasing one customer drops every key named after their number AND their LID, and nothing of anyone else", () => {
  const keys = tables();
  const removed = pruneContacts(keys, ["+919876500101"]);
  assert.ok(removed >= 9, `removed ${removed}`);
  const text = everythingText(keys);
  assert.ok(!text.includes(A_PN.slice(2)) || /group sender key/.test(text), "the number is gone from the contact tables");
  assert.ok(!text.includes(A_LID));
  assert.deepEqual(ids(keys, "session"), [`${B_LID}_1.2`, `${B_PN}.0`, `${C_PN}.0`, `${OWN_LID}_1.0`, `${OWN_PN}.0`].sort());
  assert.deepEqual(ids(keys, "device-list"), [B_PN, C_PN, OWN_PN].sort());
  assert.deepEqual(ids(keys, "lid-mapping"), [B_PN, `${B_LID}_reverse`, OWN_PN, `${OWN_LID}_reverse`].sort());
  assert.deepEqual(ids(keys, "tctoken"), [`${B_PN}@s.whatsapp.net`, "__index"].sort());
  const index = JSON.parse(Buffer.from((keys.tctoken.__index as { token: Buffer }).token).toString()) as string[];
  assert.deepEqual(index, [`${B_PN}@s.whatsapp.net`], "the index of ids no longer names the customer either");
  // The account's own keys, and the group tables, are untouched.
  assert.deepEqual(ids(keys, "pre-key"), ["1", "2"]);
  assert.deepEqual(ids(keys, "app-state-sync-key"), ["AAAA"]);
  assert.equal(ids(keys, "sender-key").length, 1);
  // Doing it twice, or for a number we hold nothing for, changes nothing.
  assert.equal(pruneContacts(keys, ["+919876500101", "+10000000000"]), 0);
});

test("a customer known only by their LID is found through the mapping, in either direction", () => {
  const keys = tables();
  delete keys["lid-mapping"][A_PN]; // only the reverse entry is left
  pruneContacts(keys, [A_PN]);
  assert.ok(!everythingText(keys).includes(A_LID));
  const other = tables();
  pruneContacts(other, [B_LID]); // asked by LID
  assert.ok(!ids(other, "session").some((id) => id.startsWith(B_PN) || id.startsWith(B_LID)));
});

test("the periodic clean-up keeps the customers with a booking and the account's own addresses, and forgets every other contact", () => {
  const keys = tables();
  const removed = pruneAllExcept(keys, [`+${B_PN}`, `+${OWN_PN}`, OWN_LID]);
  assert.ok(removed > 0);
  assert.deepEqual(contactsIn(keys).has(A_PN) || contactsIn(keys).has(A_LID) || contactsIn(keys).has(C_PN), false, "customer A and the stranger are gone");
  for (const kept of [B_PN, B_LID, OWN_PN, OWN_LID]) assert.ok(contactsIn(keys).has(kept), `${kept} is kept`);
  assert.deepEqual(ids(keys, "tctoken"), [`${B_PN}@s.whatsapp.net`, "__index"].sort());
  assert.equal(pruneAllExcept(keys, [`+${B_PN}`, `+${OWN_PN}`, OWN_LID]), 0, "idempotent");
  // With nobody to keep but the account itself, every customer goes.
  pruneAllExcept(keys, [OWN_PN]);
  assert.deepEqual([...contactsIn(keys)].sort(), [OWN_LID, OWN_PN].sort());
});

test("a customer is kept when EITHER of their addresses is in the keep list", () => {
  const keys = tables();
  pruneAllExcept(keys, [A_LID, OWN_PN]); // kept by the LID only
  assert.ok(contactsIn(keys).has(A_PN) && contactsIn(keys).has(A_LID));
  assert.ok(!contactsIn(keys).has(B_PN));
});

test("on the sealed login: after the clean-up and a flush, no copy of the number is left in what is stored", async () => {
  let stored: string | null = null;
  const timers: (() => void)[] = [];
  const auth = await EncryptedAuthState.open({
    influencerId: "inf-prune",
    storage: { load: async () => stored, save: async (s) => void (stored = s), clear: async () => void (stored = null) },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  const t = tables();
  auth.setKeys(Object.fromEntries(Object.entries(t).map(([type, entries]) => [type, entries as Record<string, unknown>])) as never);
  await auth.flush();
  assert.ok(JSON.stringify(openAuthBlob("inf-prune", stored!)).includes(A_PN));
  assert.equal(auth.mutateKeys((k) => pruneContacts(k, [A_PN])) > 0, true);
  await auth.flush();
  const text = JSON.stringify(openAuthBlob("inf-prune", stored!).keys);
  assert.ok(!text.includes(A_LID));
  assert.ok(!Object.entries(openAuthBlob("inf-prune", stored!).keys).some(([type, e]) => type !== "sender-key" && JSON.stringify(e).includes(A_PN) && type !== "device-list"), "only the group's sender key (not a contact record) still names the number");
  assert.equal(auth.mutateKeys(() => 0), 0);
  await auth.close();
  assert.equal(auth.mutateKeys(() => 5), 0, "a closed login accepts no change");
});

test("requests: well-formed ones are read, the rest ignored", () => {
  assert.deepEqual(parsePruneRequests([JSON.stringify({ phone: A_PN }), "not json", JSON.stringify({ phone: "x" }), JSON.stringify({}), JSON.stringify({ phone: `${B_PN}` })]), [A_PN, B_PN]);
  assert.equal(PRUNE_REQUEST_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

// ---- in the manager ----------------------------------------------------------------------------------------------------------

const INF = "inf-prune-mgr";

async function linkedWithContacts(keep: string[], opts: { withKeep?: boolean } = {}) {
  const h = harness();
  void opts;
  void keep;
  want(h, INF);
  await h.tick();
  const t = h.last(INF);
  t.emitQr("SECRET-QR");
  await settle();
  t.authStore.setCreds({ me: { id: `${OWN_PN}:3@s.whatsapp.net`, lid: `${OWN_LID}:3@lid` }, registered: true });
  t.authStore.setKeys(tables() as never);
  t.emitOpen({ phoneE164: `+${OWN_PN}`, deviceLabel: null });
  await settle();
  return { h, t };
}

test("an erase request published for the influencer is honoured by the manager inside its own write, and the stored login is rewritten", async () => {
  const { h } = await linkedWithContacts([]);
  await h.kv.rpush(kvKeys.prune(INF), JSON.stringify({ phone: A_PN }), PRUNE_REQUEST_TTL_MS);
  await h.clock.advance(PRUNE_REQUESTS_EVERY_MS + 1);
  await h.tick();
  await h.authTimers.fire();
  const stored = openAuthBlob(INF, h.repo.row(INF).authStateEnc!);
  assert.ok(!JSON.stringify(stored.keys).includes(A_LID));
  assert.ok(ids(stored.keys as KeyTables, "session").includes(`${B_PN}.0`));
  assert.deepEqual(await h.kv.drain(kvKeys.prune(INF)), [], "the request was taken");
  assert.ok(h.logs.some((l) => /forgot \d+ stored key\(s\) of 1 erased customer/.test(l)));
  assert.ok(!h.logs.join("\n").includes(A_PN), "the number is not logged");
  await h.manager.shutdown();
});

test("when the number starts and then every few hours, the manager forgets the contacts that have no booking left; a failing lookup prunes nothing", async () => {
  let keep: string[] = [`+${B_PN}`];
  let failing = false;
  const asked: string[] = [];
  const h = harness({
    keepContacts: async (id) => {
      asked.push(id);
      if (failing) throw new Error("database down");
      return keep;
    },
  });
  want(h, INF);
  await h.tick();
  const t = h.last(INF);
  t.emitQr("SECRET-QR");
  await settle();
  t.authStore.setCreds({ me: { id: `${OWN_PN}:3@s.whatsapp.net`, lid: `${OWN_LID}:3@lid` }, registered: true });
  t.authStore.setKeys(tables() as never);
  t.emitOpen({ phoneE164: `+${OWN_PN}`, deviceLabel: null });
  await settle();
  const live = () => contactsIn(openAuthBlobKeys(h));
  // Nothing is pruned while the first scan is in progress (no creds yet); the first pass with a login does it.
  await h.clock.advance(PRUNE_REQUESTS_EVERY_MS);
  await h.tick();
  await h.authTimers.fire();
  assert.ok(asked.length >= 1);
  assert.ok(!live().has(A_PN) && !live().has(C_PN), "customer A and the stranger are gone");
  assert.ok(live().has(B_PN) && live().has(OWN_PN) && live().has(OWN_LID), "the customer with a booking and the account's own addresses stay");

  // New contacts appear; before the next period nothing happens, after it they are cleaned.
  t.authStore.setKeys({ session: { [`${C_PN}.0`]: "again" } } as never);
  await h.clock.advance(PRUNE_ALL_EVERY_MS - PRUNE_REQUESTS_EVERY_MS * 3);
  await h.tick();
  await h.authTimers.fire();
  assert.ok(live().has(C_PN), "not yet");
  failing = true;
  await h.clock.advance(PRUNE_ALL_EVERY_MS);
  await h.tick();
  await h.authTimers.fire();
  assert.ok(live().has(C_PN), "a booking lookup that fails prunes nothing");
  assert.ok(h.logs.some((l) => /contact clean-up failed \(Error\)/.test(l)));
  failing = false;
  keep = [`+${B_PN}`, `+${C_PN}`];
  await h.clock.advance(PRUNE_ALL_EVERY_MS);
  await h.tick();
  await h.authTimers.fire();
  assert.ok(live().has(C_PN), "a customer with a booking is kept");
  await h.manager.shutdown();
});

function openAuthBlobKeys(h: ReturnType<typeof harness>): KeyTables {
  return openAuthBlob(INF, h.repo.row(INF).authStateEnc!).keys as KeyTables;
}

test("the library's key names are still the ones lib/whatsapp-web/prune.ts was written against (recheck prune.ts when this fails)", () => {
  const dir = join(process.cwd(), "node_modules", "@whiskeysockets", "baileys");
  if (!existsSync(join(dir, "package.json"))) return; // the library is not installed in this checkout
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  assert.equal(pkg.version, "7.0.0-rc14", "the library was upgraded: reread Signal/libsignal.js, Signal/lid-mapping.js and Utils/tc-token-utils.js against prune.ts");
  const read = (p: string) => readFileSync(join(dir, "lib", p), "utf8");
  const signal = read("Signal/libsignal.js");
  assert.match(signal, /signalUser = domainType !== WAJIDDomains\.WHATSAPP \? `\$\{user\}_\$\{domainType\}` : user/, "session ids: <user>[_<domainType>].<device>");
  assert.match(signal, /new libsignal\.ProtocolAddress\(signalUser, finalDevice\)/);
  assert.match(signal, /get\('device-list', \[user\]\)/, "device-list ids are the bare user");
  const lid = read("Signal/lid-mapping.js");
  assert.match(lid, /batchData\[pnUser\] = lidUser;/);
  assert.match(lid, /batchData\[`\$\{lidUser\}_reverse`\] = pnUser;/);
  assert.match(read("Utils/tc-token-utils.js"), /TC_TOKEN_INDEX_KEY = '__index'/);
});
