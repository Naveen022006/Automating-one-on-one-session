import { BRAND_NAME } from "@/lib/brand";
import { formatTitle, type SpaTitleTemplate } from "@/lib/spa/routes";

/**
 * Sets the document title. React 19 hoists a `<title>` rendered anywhere into `<head>`, and puts it BEFORE the title the
 * server wrote into the shell, so the page's own title wins.
 *
 * RULES (they follow from how the hoisting works):
 *   1. Render exactly ONE <PageTitle> per page, in the page component (a layout must not add a default title: when a
 *      layout and its page both render one, the layout's wins, because parents mount last).
 *   2. Give it the same title and template as the route's row in lib/spa/routes.ts, so the title does not flicker when
 *      React takes over from the server-rendered head: `<PageTitle title="Sessions" template="dashboard" />`.
 *   3. Render it while the page's data is still loading too, not only after it arrives (use a neutral title until then).
 */
export function PageTitle({ title, template = "brand" }: { title: string; template?: SpaTitleTemplate }) {
  return <title>{formatTitle(title, template, BRAND_NAME)}</title>;
}
