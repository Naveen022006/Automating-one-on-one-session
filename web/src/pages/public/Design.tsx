import { DesignShowcase } from "@web/pages/public/DesignShowcase";
import { PageTitle } from "../../lib/head";
import { NotFound } from "../NotFound";

/**
 * The component catalogue (doc/07 C2), imported in place from the old page's folder. The router only has the /design route in
 * a development build or one built with ENABLE_DESIGN_PAGE=true (`__DESIGN_PAGE__`); in any other build the constant is
 * `false`, this module reduces to the 404 screen, and the catalogue code does not reach the browser bundle.
 */
function DesignPage() {
  return (
    <>
      <PageTitle title="Design system" />
      <DesignShowcase />
    </>
  );
}

export const Component = __DESIGN_PAGE__ ? DesignPage : NotFound;
