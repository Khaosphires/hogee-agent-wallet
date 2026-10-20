import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '../..');
const terms = [
  'token', 'coin', 'stablecoin', 'USDC', 'x402', 'DeFi', 'RWA',
  'tokenised', 'tokenized', 'issue', 'trade', 'yield',
  'purpose-bound money', 'programmable money',
  'AI autonomously spends your money', 'We hold funds',
  'legal advice', 'tax advice', "knows every country's law",
  'compliant with', 'certified',
];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const boundary = '[\\p{L}\\p{N}_]';
const wordPattern = value => new RegExp(`(?<!${boundary})${escape(value)}(?!${boundary})`, 'giu');
const patterns = terms.map(term => ({ term, pattern: wordPattern(term) }));
// Chinese phrases have no whitespace word boundaries.
for (const term of ['代币', '通证', '发行', '交易']) {
  patterns.push({ term, pattern: new RegExp(term, 'gu') });
}
const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.txt', '.html', '.css', '.scss', '.sol', '.csv',
  '.yaml', '.yml', '.srt']);
const excludedDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'roles']);

async function filesUnder(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.env') || entry.name === 'project.md') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirs.has(entry.name)) files.push(...await filesUnder(full));
    // Do not follow symlinks, read secrets, or interpret binary artifacts as text.
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

export function checkText(text, allowed = []) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const exemptions = allowed.flatMap(phrase =>
      [...line.matchAll(wordPattern(phrase))].map(m => [m.index, m.index + m[0].length]));
    for (const { term, pattern } of patterns) {
      for (const match of line.matchAll(pattern)) {
        const start = match.index;
        if (!exemptions.some(([a, b]) => start >= a && start + match[0].length <= b)) {
          findings.push({ line: index + 1, term, matched: match[0] });
        }
      }
    }
  }
  return findings;
}

export async function lint(root = defaultRoot) {
  const allowed = (await readFile(path.join(here, 'allow.txt'), 'utf8'))
    .split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const files = [];
  for (const target of ['apps/web', 'contracts/src', 'docs/submission', 'data']) {
    const found = await filesUnder(path.join(root, target));
    files.push(...found.filter(file => target !== 'data' || file.endsWith('.json')));
  }
  const findings = [];
  for (const file of files) {
    for (const finding of checkText(await readFile(file, 'utf8'), allowed)) {
      findings.push({ file: path.relative(root, file).split(path.sep).join('/'), ...finding });
    }
  }
  return { files: files.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--root')) {
      throw new Error('Usage: node scripts/lint-wording/index.mjs [--root PATH]');
    }
    const result = await lint(args.length ? path.resolve(args[1]) : defaultRoot);
    for (const finding of result.findings) {
      console.error(`${finding.file}:${finding.line}: disallowed wording ${JSON.stringify(finding.matched)}`);
    }
    console.log(`Wording check: ${result.files} text files scanned, ${result.findings.length} findings.`);
    if (!result.files) console.log('No scoped files exist yet; this does not validate future Hogee content.');
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`Wording check failed: ${error.message}`);
    process.exitCode = 2;
  }
}
