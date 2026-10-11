import Link from "next/link";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { ButtonLink } from "@/components/ui/primitives";

export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="wordmark" aria-label={`${BRAND_NAME} home`}>
      <span className="wordmark__mark" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 8h16M4 16h10" />
        </svg>
      </span>
      {BRAND_NAME}
    </Link>
  );
}

export function SiteHeader({ loggedIn }: { loggedIn?: boolean }) {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Wordmark />
        <nav className="site-nav" aria-label="Main">
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/#features">Features</Link>
          <Link href="/#faq">FAQ</Link>
        </nav>
        <div className="site-header__actions">
          {loggedIn ? (
            <ButtonLink href="/dashboard" variant="primary" size="sm">
              Open dashboard
            </ButtonLink>
          ) : (
            <>
              <ButtonLink href="/login" variant="ghost" size="sm">
                Log in
              </ButtonLink>
              <ButtonLink href="/register" variant="primary" size="sm">
                Get started
              </ButtonLink>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__grid">
          <div className="stack stack--sm">
            <Wordmark />
            <p className="muted" style={{ maxWidth: "36ch" }}>
              Booking, payment and Google Meet links for creators who sell their time.
            </p>
          </div>
          <div>
            <h2>Product</h2>
            <ul>
              <li><Link href="/#how-it-works">How it works</Link></li>
              <li><Link href="/#features">Features</Link></li>
              <li><Link href="/demo">Demo booking page</Link></li>
              <li><Link href="/register">Create an account</Link></li>
            </ul>
          </div>
          <div>
            <h2>Legal</h2>
            <ul>
              <li><Link href="/terms">Terms of Service</Link></li>
              <li><Link href="/privacy">Privacy Policy</Link></li>
              <li><Link href="/refund-policy">Refunds and cancellations</Link></li>
            </ul>
          </div>
          <div>
            <h2>Contact</h2>
            <ul>
              <li><Link href="/contact">Contact us</Link></li>
              <li><a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></li>
            </ul>
          </div>
        </div>
        <div className="site-footer__base">
          <span>© {year} {BRAND_NAME}</span>
          <span>Payments by Razorpay. Meetings on Google Meet.</span>
        </div>
      </div>
    </footer>
  );
}

/** Focused layout for auth pages and other single-task screens. */
export function FocusedLayout({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="focused">
      <header className="focused__header">
        <div className="container">
          <Wordmark />
        </div>
      </header>
      <main id="main" className="focused__main">
        <div className="focused__card">{children}</div>
      </main>
      <footer className="focused__footer">
        {footer ?? (
          <span>
            <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> · <Link href="/contact">Help</Link>
          </span>
        )}
      </footer>
    </div>
  );
}
