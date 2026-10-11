/**
 * Environment switches for administrator security. Pure functions of the environment so tests can pass their own.
 * Both switches default to ON in production and OFF elsewhere, so a deployed console is protected unless someone
 * explicitly turns it off, while local development stays frictionless.
 */

/** "true"/"1"/"yes"/"on" and "false"/"0"/"no"/"off" (any case); anything else, including unset, uses the fallback. */
export function parseFlag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/** ADMIN_REQUIRE_2FA: every administrator must have two-factor sign-in enabled to use the console. */
export function admin2faRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.ADMIN_REQUIRE_2FA, env.NODE_ENV === "production");
}
