/**
 * The AAD an administrator's TOTP secret is encrypted with (lib/admin/mfa.ts). Kept in its own dependency-free module so the
 * key-rotation tool can import it without pulling in the admin session code (which needs Next.js).
 */
export const totpAad = (adminId: string) => `admin-totp:${adminId}`;
