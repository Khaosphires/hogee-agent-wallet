/**
 * §26.6 dashboard (task 1.12), read-only: balances, payments, traces and autonomy stats for founder and officer.
 * Every handler reads with the tenant scope from server config, never from the request, so another facility's rows
 * can be neither named nor listed (T31). Shapes and rules: services/dashboard.ts and services/payments-view.ts.
 */
import type { RouteGroup } from "../http/register";
import { autonomyStats, balances } from "../services/dashboard";
import { listPayments, listTraces, paymentWithTraces, traceEvents } from "../services/payments-view";
import { pool } from "../services/sql";

export const dashboardRoutes: RouteGroup = {
  getBalances: ({ deps, scope }) => balances(deps, scope),
  listPayments: ({ req, deps, scope }) => listPayments(pool(deps.db), scope, req.query),
  getPayment: ({ req, deps, scope }) => paymentWithTraces(pool(deps.db), scope, req.params.id),
  listTraces: ({ req, deps, scope }) => listTraces(pool(deps.db), scope, req.query),
  getTrace: ({ req, deps, scope }) => traceEvents(pool(deps.db), scope, req.params.traceId),
  getAutonomyStats: ({ deps, scope }) => autonomyStats(deps, scope),
};
