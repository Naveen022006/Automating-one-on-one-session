/**
 * Page data arrives as JSON, so every Date is an ISO string. View components take `Jsonify<XView>` props, which makes
 * `tsc` reject a `Date` method called on such a field. See lib/jsonify.ts for the full explanation.
 */
export type { Jsonify } from "@/lib/jsonify";
