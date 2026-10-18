import { keepPreviousData } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { MoneyProblem, MoneyView } from "@web/components/views/admin/MoneyView";
import type { MoneyType } from "@/lib/admin/money";
import type { AdminMoneyView } from "@/lib/views/admin-money";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

const TYPES: readonly string[] = ["all", "in", "out", "refunds", "payouts"];

/**
 * /admin/money?from&to&type&influencerId&page. The filter form is a GET form (GetForm) and the type tabs and the pagination are links, so
 * the URL is the state (keepPreviousData: see dashboard Sessions). A missing or odd date is replaced by the server (the 1st of the month to
 * today, IST). When the server refuses the request or fails, the form stays on screen with the reason instead of the generic error page.
 */
export function Component() {
  const [search] = useSearchParams();
  const from = search.get("from");
  const to = search.get("to");
  const type = search.get("type");
  const influencerId = search.get("influencerId");
  const page = search.get("page");
  const params = new URLSearchParams();
  if (from !== null) params.set("from", from);
  if (to !== null) params.set("to", to);
  if (type !== null) params.set("type", type);
  if (influencerId !== null) params.set("influencerId", influencerId);
  if (page !== null) params.set("page", page);
  const query = useApiQuery<Jsonify<AdminMoneyView>>(queryKeys.admin("money", { from, to, type, influencerId, page }), `/api/admin/money?${params}`, {
    placeholderData: keepPreviousData,
  });
  const failed = query.data === undefined && query.isError && query.error?.status !== 404;
  const status = query.error?.status ?? 0;
  return (
    <>
      <PageTitle title="Money" template="admin" />
      {failed ? (
        <MoneyProblem
          from={from ?? ""}
          to={to ?? ""}
          type={(TYPES.includes(type ?? "") ? type : "all") as MoneyType}
          influencerId={influencerId}
          title={status === 400 ? "That filter cannot be shown" : "Something went wrong"}
          message={
            status === 400 || status === 429
              ? (query.error?.serverMessage ?? "Choose a range of at most 366 days that ends after it starts.")
              : "We could not load the money ledger. Your bookings and payments are safe."
          }
          onRetry={status === 400 || status === 429 ? undefined : () => void query.refetch()}
        />
      ) : (
        <QueryGate query={query} embedded>
          {(data) => <MoneyView data={data} busy={query.isPlaceholderData} />}
        </QueryGate>
      )}
    </>
  );
}
