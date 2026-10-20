/** SG-DECISIONS: Singapore joins the country_code pg enum through one additive migration (0003), never by editing 0000. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countryCodeEnum, countryCodeValues } from '../src/schema/enums';

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const read = (file: string): string => readFileSync(join(drizzleDir, file), 'utf8');

describe('0003_sg_country (additive only)', () => {
  it('adds SG to country_code and does nothing else', () => {
    expect(read('0003_sg_country.sql').trim()).toBe(`ALTER TYPE "public"."country_code" ADD VALUE 'SG';`);
  });

  it('leaves the initial enum as it was: MY and ID, in that order', () => {
    expect(read('0000_initial_schema.sql')).toContain(`CREATE TYPE "public"."country_code" AS ENUM('MY', 'ID');`);
  });

  it('the pg enum ends with SG, so existing values keep their sort order', () => {
    expect(countryCodeEnum.enumValues).toEqual([...countryCodeValues]);
    expect(countryCodeValues.at(-1)).toBe('SG');
  });
});
