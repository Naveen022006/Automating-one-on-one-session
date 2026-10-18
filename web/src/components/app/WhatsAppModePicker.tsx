import { useEffect, useState, type ReactNode } from "react";
import { Radio } from "@web/components/ui/primitives";
import { WHATSAPP_WEB_URL, isWhatsAppWebView } from "@web/lib/whatsapp-web-ui";
import type { WhatsAppWebView } from "@/lib/whatsapp-web/types";
import { useApi } from "./ApiProvider";
import { WhatsAppConnect } from "./WhatsAppConnect";
import { WhatsAppQrLink } from "./WhatsAppQrLink";

export type WhatsAppMode = "official" | "qr";
type Mode = WhatsAppMode;

/**
 * What the picker draws, given what it knows. `view` is null until the endpoint has answered, and stays null when the platform has the
 * mode switched off or the status cannot be read: then only the official form is drawn, exactly as before the QR mode existed (no extra
 * text, no extra control). The official form keeps its slot in the tree, so nothing typed into it is lost when the choice appears.
 */
export function WhatsAppModeLayout({
  view,
  mode,
  onMode,
  qr,
  official,
}: {
  view: WhatsAppWebView | null;
  mode: Mode;
  onMode: (mode: Mode) => void;
  qr: ReactNode;
  official: ReactNode;
}) {
  const enabled = view !== null && view.enabled;
  return (
    <>
      {enabled && (
        <fieldset className="qr-modes">
          <legend>How should WhatsApp messages be sent?</legend>
          <Radio
            name="wa-mode"
            value="official"
            checked={mode === "official"}
            onChange={() => onMode("official")}
            label="Official WhatsApp Business API (Meta)"
            aria-describedby="wa-mode-official-help"
          />
          <p className="subtle qr-mode-help" id="wa-mode-official-help">
            Supported by WhatsApp, and the safer option. It needs a WhatsApp Business number and approved message templates.
          </p>
          <Radio
            name="wa-mode"
            value="qr"
            checked={mode === "qr"}
            onChange={() => onMode("qr")}
            label="Link with QR code (unofficial)"
            aria-describedby="wa-mode-qr-help"
          />
          <p className="subtle qr-mode-help" id="wa-mode-qr-help">
            Uses your own WhatsApp number as a linked device. WhatsApp&apos;s terms do not allow this and the number can be restricted or banned
            without notice. Read the risks before you link.
          </p>
        </fieldset>
      )}
      {enabled && mode === "qr" && qr}
      {(!enabled || mode === "official") && official}
    </>
  );
}

/**
 * Settings > WhatsApp. Today this is the official connection form (WhatsAppConnect) and nothing else. When the platform has the
 * optional QR-code mode switched on (`enabled` in GET /api/dashboard/whatsapp-web), a choice appears above it: the official
 * Meta connection (the default, and the safer one) or linking by QR code (unofficial). The first render, and a server render, show
 * only the official form.
 */
export function WhatsAppModePicker(props: {
  connection: React.ComponentProps<typeof WhatsAppConnect>["connection"];
  embedded: React.ComponentProps<typeof WhatsAppConnect>["embedded"];
  required?: boolean;
}) {
  const api = useApi();
  const [view, setView] = useState<WhatsAppWebView | null>(null);
  const [mode, setMode] = useState<Mode>("official");

  useEffect(() => {
    let live = true;
    void api<WhatsAppWebView>(WHATSAPP_WEB_URL).then((r) => {
      if (!live || !r.ok || !isWhatsAppWebView(r.data) || !r.data.enabled) return;
      setView(r.data);
      // Somebody who already started linking comes back to that screen; everybody else starts on the official connection.
      if (r.data.status !== "not-linked") setMode("qr");
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read when the card appears
  }, []);

  return <WhatsAppModeLayout view={view} mode={mode} onMode={setMode} qr={view && <WhatsAppQrLink initial={view} />} official={<WhatsAppConnect {...props} />} />;
}
