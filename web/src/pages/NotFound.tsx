import { NotFoundView } from "@web/components/views/system/NotFoundView";
import type { SpaTitleTemplate } from "@/lib/spa/routes";
import { PageTitle } from "../lib/head";

/**
 * The 404 screen (the shared NotFoundView). `embedded` for the `*` routes inside
 * the dashboard and admin frames, which already provide `main#main`; `template` is that area's title suffix.
 */
export function NotFound({ embedded = false, template = "brand" }: { embedded?: boolean; template?: SpaTitleTemplate }) {
  return (
    <>
      <PageTitle title="Not found" template={template} />
      <NotFoundView embedded={embedded} />
    </>
  );
}

export const Component = NotFound;
