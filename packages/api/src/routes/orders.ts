/**
 * POST /api/orders/terms and GET /api/orders/terms/:id (VISION-DECISIONS §5, §9): the ONLY way a payout account
 * arrives (never chat, listing text or a model). The checks and the immutable row: services/supplier-terms.ts.
 */
import type { RouteGroup } from "../http/register";
import { confirmOrderTerms, readOrderTerms } from "../services/supplier-terms";

export const orderRoutes: RouteGroup = {
  submitOrderTerms: ({ req, deps, scope }) => confirmOrderTerms(deps, scope, req.body),
  getOrderTerms: ({ req, deps, scope }) => readOrderTerms(deps, scope, req.params.id),
};
