import type { ReactNode } from "react";
import { PageHead } from "@/components/ui/page-section";

/**
 * Retired (UX round 3): every page's head is `PageHead` from components/ui/page-section.tsx. This thin alias keeps the
 * pages that still import it compiling until their owners switch (title → title, description → line, children →
 * aside); it renders exactly a PageHead. Don't use it in new code.
 * @deprecated Use `PageHead` from "@/components/ui/page-section".
 */
export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <PageHead title={title} line={description} aside={children} />;
}
