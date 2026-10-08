import { redirect } from "next/navigation";
import { getAuth, type AuthContext } from "./session";

/**
 * Page guard for the logged-in app: unauthenticated visitors go to /login?next=<path>, and accounts that have not
 * finished onboarding go to /onboarding (unless they are already there).
 */
export async function requirePageAuth(path: string, opts: { allowOnboarding?: boolean } = {}): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect(`/login?next=${encodeURIComponent(path)}`);
  if (!auth.onboarded && !opts.allowOnboarding) redirect("/onboarding");
  return auth;
}
