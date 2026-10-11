import { LandingView } from "@web/components/views/public/LandingView";
import { PageTitle } from "../../lib/head";
import { useSession } from "../../lib/session";

/**
 * The landing page (app/page.tsx without the server work). The Organization JSON-LD is written into the shell's head by
 * the server (lib/spa/head.ts). The page does not wait for the session check: an anonymous visitor (the usual case) gets
 * the right header at once, and a signed-in one sees "Open dashboard" as soon as the check answers. A failed check counts
 * as signed out, like the old page's `getAuth().catch(() => null)`.
 */
export function Component() {
  const session = useSession();
  return (
    <>
      <PageTitle title="{brand}: get paid for your time, send the Meet link automatically" template="absolute" />
      <LandingView loggedIn={session.data?.authenticated === true} />
    </>
  );
}
