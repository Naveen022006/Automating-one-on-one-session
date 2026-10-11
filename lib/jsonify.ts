/**
 * JSON round trip for page data (doc/12-front-end.md).
 *
 * A "view function" (lib/views/*.ts) returns plain server data (Prisma rows turned into explicit DTOs, with `Date`
 * fields). The SPA receives that data as JSON, where every Date is an ISO string. The view components therefore take their
 * data as Jsonify<XView>, and tests build that shape from server data with jsonify(). A component that still calls a Date
 * method on such a field then fails to type-check, instead of printing a raw ISO string in production.
 *
 * Client-safe: no imports, so web/ may import it (it is on the server-module guard's allowlist).
 */

type JsonPrimitive = string | number | boolean | null;

/**
 * What JSON.parse(JSON.stringify(value)) gives back, as a type: Date -> string, no functions/symbols/bigint,
 * optional properties stay optional. `unknown` and `any` stay as they are (a field typed `unknown` is the author's way of
 * saying "arbitrary JSON"; mapping it to `never` would make it impossible to use).
 */
export type Jsonify<T> = unknown extends T
  ? T
  : T extends Date
    ? string
    : T extends JsonPrimitive | undefined
      ? T
      : T extends bigint | symbol | ((...args: never[]) => unknown)
        ? never
        : T extends readonly unknown[]
          ? { [K in keyof T]: Jsonify<T[K]> }
          : T extends object
            ? { [K in keyof T]: Jsonify<T[K]> }
            : never;

/** `JSON.parse(JSON.stringify(value))`, typed as Jsonify<T>. `undefined` stays `undefined`. */
export function jsonify<T>(value: T): Jsonify<T> {
  if (value === undefined) return undefined as Jsonify<T>;
  return JSON.parse(JSON.stringify(value)) as Jsonify<T>;
}
