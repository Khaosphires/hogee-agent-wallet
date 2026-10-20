import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema/index';

export type TableConfig = ReturnType<typeof getTableConfig>;

/** Every pgTable exported from the schema, as table configs. */
export const tableConfigs: TableConfig[] = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

export const tableByName = (name: string): TableConfig => {
  const config = tableConfigs.find((t) => t.name === name);
  if (!config) throw new Error(`table ${name} not found in schema`);
  return config;
};

export const columnNames = (t: TableConfig): string[] => t.columns.map((c) => c.name);

export const column = (t: TableConfig, name: string) => {
  const col = t.columns.find((c) => c.name === name);
  if (!col) throw new Error(`column ${t.name}.${name} not found`);
  return col;
};

const indexColumnNames = (cols: readonly unknown[]): string[] =>
  cols.map((c) =>
    typeof c === 'object' && c !== null && 'name' in c && typeof c.name === 'string' ? c.name : '?',
  );

/** Ordered column lists of every key-like structure (PK, unique, non-partial index). */
export function keyColumnLists(t: TableConfig, opts: { uniqueOnly: boolean }): string[][] {
  const lists: string[][] = [];
  for (const c of t.columns) {
    if (c.primary) lists.push([c.name]);
    if (c.isUnique) lists.push([c.name]);
  }
  for (const pk of t.primaryKeys) lists.push(pk.columns.map((c) => c.name));
  for (const uq of t.uniqueConstraints) lists.push(uq.columns.map((c) => c.name));
  for (const ix of t.indexes) {
    if (ix.config.where) continue;
    if (opts.uniqueOnly && !ix.config.unique) continue;
    lists.push(indexColumnNames(ix.config.columns));
  }
  return lists;
}

export const hasUnique = (t: TableConfig, cols: string[]): boolean =>
  keyColumnLists(t, { uniqueOnly: true }).some(
    (list) => list.length === cols.length && list.every((c, i) => c === cols[i]),
  );

export const checkNames = (t: TableConfig): string[] => t.checks.map((c) => c.name);

/** Every unique key (column PK/unique, composite PK, unique constraint, unique index incl. partial). */
export function uniqueKeys(t: TableConfig): Array<{ name: string; columns: string[] }> {
  const keys: Array<{ name: string; columns: string[] }> = [];
  for (const c of t.columns) {
    if (c.primary || c.isUnique) keys.push({ name: `${t.name}.${c.name}`, columns: [c.name] });
  }
  for (const pk of t.primaryKeys) {
    keys.push({ name: pk.getName() ?? `${t.name}_pk`, columns: pk.columns.map((c) => c.name) });
  }
  for (const uq of t.uniqueConstraints) {
    keys.push({ name: uq.getName() ?? `${t.name}_unique`, columns: uq.columns.map((c) => c.name) });
  }
  for (const ix of t.indexes) {
    if (ix.config.unique) keys.push({ name: ix.config.name ?? '?', columns: indexColumnNames(ix.config.columns) });
  }
  return keys;
}

/** Foreign keys as plain column-name lists plus the referenced table name. */
export function foreignKeyRefs(t: TableConfig) {
  return t.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      name: fk.getName(),
      columns: ref.columns.map((c) => c.name),
      foreignTable: getTableConfig(ref.foreignTable).name,
      foreignColumns: ref.foreignColumns.map((c) => c.name),
    };
  });
}
