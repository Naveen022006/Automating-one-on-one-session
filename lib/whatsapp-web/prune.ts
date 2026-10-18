/**
 * Forgetting customers' contact keys in a linked device's stored login.
 *
 * WhatsApp's end-to-end encryption keeps per-contact state (sessions, device lists, a token, the phone-to-LID mapping) in the
 * "Signal keys" of the login, and those keys are named after the contact's WhatsApp address, which contains the customer's phone
 * number. So the stored login holds phone numbers of customers even though no message text is stored. When a customer's data is erased
 * (lib/privacy.ts) the manager drops that contact's keys from the login, and every few hours it drops the contacts that no longer
 * belong to any non-erased booking of the influencer. A contact that is still needed is simply set up again by the library on the
 * next message.
 *
 * !! THE KEY NAMES BELOW ARE THE LIBRARY'S, NOT OURS. They were read from @whiskeysockets/baileys 7.0.0-rc14 (Signal/libsignal.js
 * `jidToSignalProtocolAddress`, Signal/lid-mapping.js, Utils/tc-token-utils.js) and are isolated in `keyOwner` / `LID_REVERSE`
 * / `TC_TOKEN_INDEX` so there is ONE place to fix. RECHECK THEM WHEN THE LIBRARY IS UPGRADED (tests/whatsapp-web-prune.test.ts pins
 * the patterns, and its last test loads the real library to compare the sentinel names). A wrong pattern fails safe in one direction
 * only: contacts are kept longer than intended, never a key that is needed for the account itself (the account's own keys use other
 * tables: pre-key, app-state-sync-key, ...).
 *
 *   session          "<user>[_<domainType>].<device>"   e.g. "919876500101.0", "123456789012345_1.0"
 *   identity-key     the same id as `session` (Signal/libsignal.js loadIdentityKey / saveIdentity use the same wire address)
 *   device-list      "<user>"
 *   lid-mapping      "<pnUser>" -> lidUser,  "<lidUser>_reverse" -> pnUser
 *   tctoken          "<user>[:<device>]@s.whatsapp.net" | "...@lid", plus the index entry "__index" (a JSON list of such ids)
 *   sender-key       "<groupJid>::<user>[_<domainType>]::<device>"  (a group member's sender key; the id names the member)
 *   sender-key-memory  id = the group's JID; the VALUE is a map { "<user>@s.whatsapp.net|@lid": true } of members: the member entries are removed
 *   creds.processedHistoryMessages  [{ key: { remoteJid, participant, id }, ... }]: entries naming the contact are removed (history sync is
 *                    switched off in the adapter, so this normally stays empty)
 *
 * Every key type the library declares (Types/Auth.d.ts SignalDataTypeMap) was checked: pre-key (own numeric pre-key ids),
 * app-state-sync-key (random key ids) and app-state-sync-version (names such as "regular_high") contain no contact address and are left
 * alone; every other type is in the tables above. A test reads the declared list from the library and fails when a type appears that is
 * neither covered nor listed as address-free.
 *
 * Pure: it works on the in-memory key tables (type -> id -> value) of lib/whatsapp-web/auth-state.ts.
 */

export type KeyTables = Record<string, Record<string, unknown>>;

/** The tables whose ids name a contact. Everything else (own pre-keys, app-state keys, sender keys of groups) is left alone. */
const CONTACT_TABLES = ["session", "identity-key", "device-list", "lid-mapping", "tctoken", "sender-key"] as const;

/** Key types that hold no contact address (see the header). Exported so the test can compare it with the library's own list. */
export const ADDRESS_FREE_TABLES = ["pre-key", "app-state-sync-key", "app-state-sync-version"] as const;
/** The one type whose address is in the VALUE (a map of members), handled by `removeUsers`. */
const MEMBER_MAP_TABLE = "sender-key-memory";
/** Every key type this module accounts for. */
export const ACCOUNTED_KEY_TYPES: readonly string[] = [...CONTACT_TABLES, MEMBER_MAP_TABLE, ...ADDRESS_FREE_TABLES];

const LID_REVERSE = "_reverse";
const TC_TOKEN_INDEX = "__index";

/** The "user" (phone number or LID, digits only) a key id belongs to, or null when the id is not one of a contact's. */
export function keyOwner(type: string, id: string): string | null {
  switch (type) {
    case "session":
    case "identity-key":
      return /^(\d+)(?:_\d+)?\.\d+$/.exec(id)?.[1] ?? null;
    case "sender-key":
      return /^[^:]*::(\d+)(?:_\d+)?::\d+$/.exec(id)?.[1] ?? null;
    case "device-list":
      return /^(\d+)$/.exec(id)?.[1] ?? null;
    case "lid-mapping":
      return /^(\d+)(?:_reverse)?$/.exec(id)?.[1] ?? null;
    case "tctoken":
      return /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|lid|c\.us)$/.exec(id)?.[1] ?? null;
    default:
      return null;
  }
}

/** "+91 98765 00101" or "919876500101" -> "919876500101". */
export const digitsOf = (e164: string): string => e164.replace(/\D/g, "");

/** The user part of a JID such as "919876500001:12@s.whatsapp.net" or "123@lid". */
export function jidUser(jid: unknown): string | null {
  if (typeof jid !== "string") return null;
  return /^(\d+)(?::\d+)?@/.exec(jid)?.[1] ?? null;
}

/** A phone number's other addresses: the LID(s) the mapping holds for it. */
function aliasesOf(keys: KeyTables, user: string): Set<string> {
  const out = new Set<string>([user]);
  const mapping = keys["lid-mapping"] ?? {};
  const forward = mapping[user];
  if (typeof forward === "string" && /^\d+$/.test(forward)) out.add(forward);
  for (const [id, value] of Object.entries(mapping)) {
    if (id.endsWith(LID_REVERSE) && value === user) out.add(id.slice(0, -LID_REVERSE.length));
  }
  // A LID given as the target: its phone number is in the reverse entry.
  const reverse = mapping[`${user}${LID_REVERSE}`];
  if (typeof reverse === "string" && /^\d+$/.test(reverse)) out.add(reverse);
  return out;
}

function readIndex(entry: unknown): string[] | null {
  const token = (entry as { token?: unknown } | undefined)?.token;
  if (!(token instanceof Uint8Array)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token).toString()) as unknown;
    return Array.isArray(parsed) ? parsed.filter((j): j is string => typeof j === "string") : null;
  } catch {
    return null;
  }
}

/** The entries of `creds.processedHistoryMessages` ({ key: { remoteJid, participant } }) and the users they name. */
function historyEntries(creds: unknown): { list: unknown[]; owners: (entry: unknown) => (string | null)[] } | null {
  const list = (creds as { processedHistoryMessages?: unknown } | null | undefined)?.processedHistoryMessages;
  if (!Array.isArray(list)) return null;
  return {
    list,
    owners: (entry) => {
      const key = (entry as { key?: { remoteJid?: unknown; participant?: unknown } } | null)?.key;
      return [jidUser(key?.remoteJid), jidUser(key?.participant)];
    },
  };
}

/** Removes the history entries that name one of `users`. Returns how many were removed. */
function removeUsersFromCreds(creds: unknown, users: Set<string>): number {
  const history = historyEntries(creds);
  if (!history) return 0;
  const kept = history.list.filter((entry) => !history.owners(entry).some((o) => o !== null && users.has(o)));
  const removed = history.list.length - kept.length;
  if (removed > 0) (creds as { processedHistoryMessages: unknown[] }).processedHistoryMessages = kept;
  return removed;
}

/** Removes every key that belongs to one of `users`. Returns how many entries were removed or rewritten. */
function removeUsers(keys: KeyTables, users: Set<string>, creds?: unknown): number {
  let removed = removeUsersFromCreds(creds, users);
  // The group "who already has my sender key" memory: the members are the keys of the value.
  for (const value of Object.values(keys[MEMBER_MAP_TABLE] ?? {})) {
    if (value === null || typeof value !== "object") continue;
    const members = value as Record<string, unknown>;
    for (const jid of Object.keys(members)) {
      const owner = jidUser(jid);
      if (owner !== null && users.has(owner)) {
        delete members[jid];
        removed += 1;
      }
    }
  }
  for (const type of CONTACT_TABLES) {
    const table = keys[type];
    if (!table) continue;
    for (const id of Object.keys(table)) {
      if (type === "tctoken" && id === TC_TOKEN_INDEX) {
        const list = readIndex(table[id]);
        if (list) {
          const kept = list.filter((jid) => {
            const owner = jidUser(jid);
            return owner === null || !users.has(owner);
          });
          if (kept.length !== list.length) {
            table[id] = { ...(table[id] as object), token: Buffer.from(JSON.stringify(kept)) };
            removed += list.length - kept.length;
          }
        }
        continue;
      }
      const owner = keyOwner(type, id);
      if (owner !== null && users.has(owner)) {
        delete table[id];
        removed += 1;
      }
    }
  }
  return removed;
}

/** Forgets the contacts for these phone numbers (E.164 or digits), with their LID aliases. Returns the number of entries removed. */
export function pruneContacts(keys: KeyTables, phones: Iterable<string>, creds?: unknown): number {
  const users = new Set<string>();
  for (const phone of phones) {
    const user = digitsOf(phone);
    if (!user) continue;
    for (const a of aliasesOf(keys, user)) users.add(a);
  }
  return users.size === 0 ? 0 : removeUsers(keys, users, creds);
}

/** Every contact (phone number or LID, digits) the key tables hold something for. */
export function contactsIn(keys: KeyTables, creds?: unknown): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(keys[MEMBER_MAP_TABLE] ?? {})) {
    if (value === null || typeof value !== "object") continue;
    for (const jid of Object.keys(value as object)) {
      const owner = jidUser(jid);
      if (owner !== null) out.add(owner);
    }
  }
  const history = historyEntries(creds);
  if (history) for (const entry of history.list) for (const owner of history.owners(entry)) if (owner !== null) out.add(owner);
  for (const type of CONTACT_TABLES) {
    for (const id of Object.keys(keys[type] ?? {})) {
      const owner = keyOwner(type, id);
      if (owner !== null) out.add(owner);
    }
  }
  return out;
}

/**
 * Forgets every contact except those in `keep` (the customers' numbers with a non-erased booking, and the account's own addresses).
 * A contact is kept when ANY of its addresses (phone number or LID) is in `keep`. Returns the number of entries removed.
 */
export function pruneAllExcept(keys: KeyTables, keep: Iterable<string>, creds?: unknown): number {
  const keepSet = new Set<string>();
  for (const k of keep) {
    const user = digitsOf(k);
    if (!user) continue;
    for (const a of aliasesOf(keys, user)) keepSet.add(a);
  }
  const drop = new Set<string>();
  for (const user of contactsIn(keys, creds)) {
    if (keepSet.has(user)) continue;
    for (const a of aliasesOf(keys, user)) {
      if (keepSet.has(a)) {
        keepSet.add(user);
        break;
      }
    }
    if (!keepSet.has(user)) drop.add(user);
  }
  return drop.size === 0 ? 0 : removeUsers(keys, drop, creds);
}
