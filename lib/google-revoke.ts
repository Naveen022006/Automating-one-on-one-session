import { revokeToken } from "@/lib/google";
import type { GoogleAccountRef } from "@/lib/google-connect";
import { googleAccountSharedWithOthers } from "@/lib/google-tokens";

/**
 * Revokes a grant we are not keeping, unless another influencer profile is connected with the same Google account (Google's revoke ends the
 * app's access for the whole account, so it would disconnect that profile too). `revokeToken` itself never throws; the shared-account lookup
 * can (database), so callers that must not fail because of it catch.
 */
export async function revokeGrantUnlessShared(influencerId: string, refreshToken: string, account: GoogleAccountRef): Promise<void> {
  if (!(await googleAccountSharedWithOthers(influencerId, account.email, account.sub))) await revokeToken(refreshToken);
}
