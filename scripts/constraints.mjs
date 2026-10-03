// Reads values from constraints.yaml, the single source of truth for thresholds and
// naming patterns. Lint, coverage and duplicate-code configs import from here instead
// of hardcoding numbers. A missing key throws: a silently absent threshold is a
// disabled gate.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('../constraints.yaml', import.meta.url);

function topLevelBlock(text, section) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${section}:`);
  if (start === -1) throw new Error(`constraints.yaml: section "${section}" not found`);
  const end = lines.findIndex((line, index) => index > start && /^[A-Za-z_]/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function keyBlock(text, section, key) {
  const block = topLevelBlock(text, section);
  const start = block.findIndex((line) => line === `  ${key}:`);
  if (start === -1) throw new Error(`constraints.yaml: key "${section}.${key}" not found`);
  const end = block.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return block.slice(start + 1, end === -1 ? block.length : end);
}

/** Returns the scalar under `<section>.<key>.value` as a string. */
export function constraintValue(section, key, text = readFileSync(SOURCE, 'utf8')) {
  const match = keyBlock(text, section, key)
    .map((line) => /^ {4}value:\s*([^#\s]+)/.exec(line))
    .find((found) => found !== null);
  if (!match) throw new Error(`constraints.yaml: "${section}.${key}.value" not found`);
  return match[1];
}

/** Returns the numeric threshold under `<section>.<key>.value`. */
export function constraintNumber(section, key, text) {
  const raw = constraintValue(section, key, text);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`constraints.yaml: "${section}.${key}.value" is not a number: "${raw}"`);
  }
  return value;
}

/** Returns the forbidden naming-suffix regex sources, snake_case form first. */
export function forbiddenSuffixPatterns(text = readFileSync(SOURCE, 'utf8')) {
  const patterns = keyBlock(text, 'code_canonicality', 'forbidden_suffixes')
    .map((line) => /^ {6}- "(.+)"\s*$/.exec(line))
    .filter((found) => found !== null)
    .map((found) => found[1]);
  if (patterns.length !== 2) {
    throw new Error(
      `constraints.yaml: expected 2 forbidden suffix patterns, found ${String(patterns.length)}`,
    );
  }
  return patterns;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [section, key] = process.argv.slice(2);
  if (!section || !key) {
    process.stderr.write('usage: node scripts/constraints.mjs <section> <key>\n');
    process.exit(2);
  }
  process.stdout.write(`${constraintValue(section, key)}\n`);
}
