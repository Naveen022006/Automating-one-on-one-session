import { renderSVG } from "uqr";

/**
 * Renders the QR payload of a linking attempt as an inline SVG string, ON THE SERVER: the browser imports no QR library, it only
 * puts this string on the page. The result is plain geometry (rect + path made of numbers), never script and never any part of
 * the payload as text. Dark modules on a white field with a quiet zone, whatever the page theme, because phones scan dark-on-light.
 */
export function renderQrSvg(payload: string): string {
  const svg = renderSVG(payload, { ecc: "L", border: 2, whiteColor: "#ffffff", blackColor: "#000000" });
  return svg.replace("<svg ", '<svg role="img" aria-label="WhatsApp link code" ');
}
