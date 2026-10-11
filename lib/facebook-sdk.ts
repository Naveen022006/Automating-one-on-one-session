/**
 * Which Facebook SDK script the WhatsApp sign-up (Embedded Signup) card loads. Kept free of imports and of any environment
 * access so the card in the browser can use it (lib/whatsapp-graph-version.ts is the same kind of module).
 *
 * Meta's SDK, unless the server handed over the local mock's SDK (lib/whatsapp-connect.ts embeddedSignupConfig adds `sdkUrl`
 * only while the guarded local-mock override is active, see lib/provider-endpoints.ts). The browser accepts that only
 * if it is a loopback mock URL, so a production server (which never sends one) or a tampered value can never make the page load
 * a script from anywhere else. Double-guarded on purpose.
 */

export const FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";

const MOCK_SDK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/meta\/en_US\/sdk\.js$/;

/** The SDK to load: the server-supplied mock SDK only if it is a loopback mock URL, otherwise Meta's. */
export function chooseFacebookSdkUrl(candidate: string | null | undefined): string {
  return candidate && MOCK_SDK.test(candidate) ? candidate : FACEBOOK_SDK_URL;
}
