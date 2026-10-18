import { useEffect, useState, type ReactNode } from "react";
import { WHATSAPP_WEB_URL, isWhatsAppWebView } from "@web/lib/whatsapp-web-ui";
import type { WhatsAppWebView } from "@/lib/whatsapp-web/types";
import { useApi } from "./ApiProvider";
import { WhatsAppConnect } from "./WhatsAppConnect";
import { WhatsAppQrLink } from "./WhatsAppQrLink";

/**
 * What the WhatsApp card draws, given what it knows. `view` is null until the endpoint has answered, and stays null when the platform
 * has the mode switched off or the status cannot be read: then only the official form is drawn, exactly as before the QR mode
 * existed (no extra text, no extra control). The official form keeps its slot in the tree, so nothing typed into it is lost when the
 * QR section appears.
 *
 * With the QR mode on there are two INDEPENDENT sections, both always visible: the official connection and the QR link. Neither is a
 * "choice" that hides the other: the server does not keep a preference, it uses a QR link whenever one is active, and a hidden QR
 * panel would hide its status and its Disconnect button. The note between them says how the two fit together.
 */
export function WhatsAppModeLayout({ view, qr, official }: { view: WhatsAppWebView | null; qr: ReactNode; official: ReactNode }) {
  const enabled = view !== null && view.enabled;
  if (!enabled) return <>{official}</>;
  return (
    <div className="stack qr-sections">
      <section className="stack" aria-labelledby="wa-official-heading">
        <h3 id="wa-official-heading">Official WhatsApp Business API (Meta)</h3>
        <p className="subtle">Supported by WhatsApp, and the safer option. It needs a WhatsApp Business number and approved message templates.</p>
        {official}
      </section>
      <p className="subtle qr-sections__note" id="wa-order-note">
        When a QR link is active, booking messages are sent from it first; otherwise the official connection, then SMS and e-mail. To stop using
        the QR link, disconnect it.
      </p>
      <section className="stack" aria-labelledby="wa-qr-heading">
        <h3 id="wa-qr-heading">Link with QR code (unofficial)</h3>
        <p className="subtle">
          Uses your own WhatsApp number as a linked device. WhatsApp&apos;s terms do not allow this and the number can be restricted or banned
          without notice. Read the risks before you link.
        </p>
        {qr}
      </section>
    </div>
  );
}

/**
 * Settings > WhatsApp. Today this is the official connection form (WhatsAppConnect) and nothing else. When the platform has the
 * optional QR-code mode switched on (`enabled` in GET /api/dashboard/whatsapp-web), the QR link appears as its own section next to it
 * (see WhatsAppModeLayout). The first render, and a server render, show only the official form.
 */
export function WhatsAppModePicker(props: {
  connection: React.ComponentProps<typeof WhatsAppConnect>["connection"];
  embedded: React.ComponentProps<typeof WhatsAppConnect>["embedded"];
  required?: boolean;
}) {
  const api = useApi();
  const [view, setView] = useState<WhatsAppWebView | null>(null);

  useEffect(() => {
    let live = true;
    void api<WhatsAppWebView>(WHATSAPP_WEB_URL).then((r) => {
      if (!live || !r.ok || !isWhatsAppWebView(r.data) || !r.data.enabled) return;
      setView(r.data);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read when the card appears
  }, []);

  return <WhatsAppModeLayout view={view} qr={view && <WhatsAppQrLink initial={view} />} official={<WhatsAppConnect {...props} />} />;
}
