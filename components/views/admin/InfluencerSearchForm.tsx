"use client";

import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui/primitives";

/**
 * The influencer search box. A plain GET form (it works without JavaScript, with the same field name as before), but with
 * JavaScript the submit is a client-side navigation: in the SPA a React Router route change, on the old Next page a Next one,
 * instead of a full page load. `key` on the form makes it start again from the URL's value after back/forward.
 */
export function InfluencerSearchForm({ q }: { q?: string }) {
  const router = useRouter();
  return (
    <form
      key={q ?? ""}
      className="row"
      style={{ alignItems: "flex-end" }}
      action="/admin/influencers"
      onSubmit={(e) => {
        e.preventDefault();
        const value = new FormData(e.currentTarget).get("q");
        router.push(`/admin/influencers?q=${encodeURIComponent(typeof value === "string" ? value : "")}`);
      }}
    >
      <Input name="q" placeholder="Search name, email or page address" defaultValue={q} aria-label="Search influencers" />
      <Button type="submit">Search</Button>
    </form>
  );
}
