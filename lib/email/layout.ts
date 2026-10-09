import { BRAND_NAME, SUPPORT_EMAIL } from "@/lib/brand";

/**
 * One responsive, table-based email layout shared by every message (same visual language as the web app: ink
 * text, one green accent, quiet borders, a serif heading). Inline styles only, because most email clients
 * strip <style> blocks. Every dynamic value is HTML-escaped. A plain-text alternative is produced from the
 * same content so text-only clients and spam filters get an equivalent message.
 */

export interface EmailContent {
  /** Hidden preview line shown by inbox list views. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Label/value rows rendered as a summary table (service, time, amount...). */
  details?: [label: string, value: string][];
  button?: { label: string; url: string };
  /** Extra links under the button, e.g. "Reschedule or cancel". */
  links?: { label: string; url: string }[];
  /** Small print at the bottom (why you got this email). */
  footnote?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const C = {
  ink: "#162033",
  muted: "#5b6170",
  border: "#e4e2dc",
  bg: "#f6f5f1",
  surface: "#ffffff",
  accent: "#17694f",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url: string): string {
  // Only http(s) links are ever rendered.
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "#";
}

export function renderEmail(subject: string, c: EmailContent): RenderedEmail {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif";
  const serif = "Georgia,'Times New Roman',serif";

  const paragraphs = c.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font:16px/1.6 ${font};color:${C.ink}">${escapeHtml(p)}</p>`)
    .join("");

  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-radius:8px;margin:8px 0 24px">${c.details
        .map(
          ([k, v], i) =>
            `<tr><td style="padding:12px 16px;${i ? `border-top:1px solid ${C.border};` : ""}font:14px/1.4 ${font};color:${C.muted};width:38%;vertical-align:top">${escapeHtml(k)}</td><td style="padding:12px 16px;${i ? `border-top:1px solid ${C.border};` : ""}font:15px/1.4 ${font};color:${C.ink};vertical-align:top;word-break:break-word">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:6px;background:${C.accent}"><a href="${safeUrl(c.button.url)}" style="display:inline-block;padding:13px 22px;font:600 15px/1 ${font};color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(c.button.label)}</a></td></tr></table>`
    : "";

  const links = c.links?.length
    ? `<p style="margin:0 0 16px;font:14px/1.6 ${font};color:${C.muted}">${c.links
        .map((l) => `<a href="${safeUrl(l.url)}" style="color:${C.accent};text-decoration:underline">${escapeHtml(l.label)}</a>`)
        .join(" &nbsp;·&nbsp; ")}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font:600 15px/1 ${font};color:${C.ink};letter-spacing:.01em">${escapeHtml(BRAND_NAME)}</td></tr>
<tr><td style="background:${C.surface};border:1px solid ${C.border};border-radius:10px;padding:32px 28px">
<h1 style="margin:0 0 16px;font:500 26px/1.25 ${serif};color:${C.ink}">${escapeHtml(c.heading)}</h1>
${paragraphs}${details}${button}${links}
</td></tr>
<tr><td style="padding:16px 4px;font:12px/1.6 ${font};color:${C.muted}">${c.footnote ? `${escapeHtml(c.footnote)}<br>` : ""}Questions? Reply to this email or write to <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:${C.muted}">${escapeHtml(SUPPORT_EMAIL)}</a>.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((p) => [p, ""]),
    ...(c.details?.length ? [...c.details.map(([k, v]) => `${k}: ${v}`), ""] : []),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ""] : []),
    ...(c.links ?? []).map((l) => `${l.label}: ${l.url}`),
    ...(c.links?.length ? [""] : []),
    ...(c.footnote ? [c.footnote, ""] : []),
    `Questions? Write to ${SUPPORT_EMAIL}.`,
    `— ${BRAND_NAME}`,
  ].join("\n");

  return { subject, html, text };
}
