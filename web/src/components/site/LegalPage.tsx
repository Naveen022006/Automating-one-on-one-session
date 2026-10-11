import { SiteFooter, SiteHeader } from "@web/components/site/SiteChrome";
import { Alert, Breadcrumb } from "@web/components/ui/primitives";

/** Shared shell for legal pages. Every page is clearly marked as a draft until the owner and a lawyer approve it. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="container container--narrow" style={{ paddingTop: 40 }}>
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: title }]} />
        <h1 className="display" style={{ fontSize: "var(--text-3xl)", marginTop: 16 }}>
          {title}
        </h1>
        <p className="subtle" style={{ marginTop: 8 }}>Last updated {updated}</p>
        <div style={{ marginTop: 24 }}>
          <Alert tone="warning" title="Draft for review">
            This text is a starting draft. It must be reviewed and approved by the business owner and a qualified
            lawyer before it is relied on.
          </Alert>
        </div>
        <article className="prose" style={{ marginTop: 32 }}>
          {children}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
