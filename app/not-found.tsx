import Link from "next/link";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { ButtonLink } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <p className="eyebrow">404</p>
        <h1 className="focused__title">This page does not exist</h1>
        <p className="muted">
          The link may be mistyped, or the booking page may have moved to a new address. If you were sent here by a host,
          ask them for their current link.
        </p>
        <div className="row">
          <ButtonLink href="/" variant="primary">
            Go to the home page
          </ButtonLink>
          <Link href="/contact">Contact us</Link>
        </div>
      </div>
    </FocusedLayout>
  );
}
