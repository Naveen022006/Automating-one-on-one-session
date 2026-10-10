import { NotFoundView } from "@/components/views/system/NotFoundView";

// The content lives in a shared view so the SPA's NotFound page renders exactly the same screen.
export default function NotFound() {
  return <NotFoundView />;
}
