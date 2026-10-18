import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { CopyField, Dialog, useToast } from "@web/components/ui/overlays";
import { Alert, Button } from "@web/components/ui/primitives";

/**
 * "Mark e-mail verified" and "Create password reset link" on the admin Influencer page (doc/15). They exist because the platform may send
 * no e-mail: without them nobody could verify an address or recover a password. The reset link is shown ONCE, in a dialog, to be handed
 * over by the administrator; it is never stored on the page, in the query cache or in the address bar, and closing the dialog drops it.
 */
export function AccountHelpActions({ influencerId, emailVerified, emailEnabled }: { influencerId: string; emailVerified: boolean; emailEnabled: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<"verify" | "link" | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);

  async function verify() {
    setBusy("verify");
    try {
      const res = await fetch(`/api/admin/influencers/${influencerId}/verify-email`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(data.error ?? "Could not mark the email as verified.", "error");
        if (res.status === 409) router.refresh();
        return;
      }
      toast("Email marked as verified.");
      router.refresh();
    } catch {
      toast("Could not reach the server. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function createLink() {
    setBusy("link");
    try {
      const res = await fetch(`/api/admin/influencers/${influencerId}/reset-link`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; url?: string; expiresAt?: string };
      if (!res.ok || !data.url || !data.expiresAt) {
        toast(data.error ?? "Could not create the reset link.", "error");
        return;
      }
      setLink({ url: data.url, expiresAt: data.expiresAt });
    } catch {
      toast("Could not reach the server. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack stack--sm">
      {!emailEnabled && (
        <p className="subtle">This site sends no e-mail. Verify addresses and hand over password-reset links by hand.</p>
      )}
      <div className="row">
        {!emailVerified && (
          <Button size="sm" onClick={() => void verify()} loading={busy === "verify"}>
            Mark email verified
          </Button>
        )}
        <Button size="sm" onClick={() => void createLink()} loading={busy === "link"}>
          Create password reset link
        </Button>
      </div>
      <Dialog
        open={link !== null}
        onClose={() => setLink(null)}
        title="Password reset link"
        description="Send this link to the influencer yourself. It works once and expires at the time below. It is shown only now and is not saved anywhere you can look it up again."
        footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}
      >
        {link && (
          <div className="stack">
            <CopyField value={link.url} label="Copy link" />
            <Alert tone="info">
              Expires {new Date(link.expiresAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. Creating another link cancels this one.
            </Alert>
          </div>
        )}
      </Dialog>
    </div>
  );
}
