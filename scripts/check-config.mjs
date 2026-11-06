import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import ts from 'typescript';

function platformReads() {
  const file = ts.createSourceFile(
    'config.ts',
    readFileSync('platform/src/config.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  if (file.parseDiagnostics.length !== 0) throw new Error('Cannot parse config.ts inventory');
  const names = new Set();
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === 'env') {
      const parent = node.parent;
      if (ts.isParameter(parent) && parent.name === node) return;
      let name;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
        name = parent.name.text;
      else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteral(parent.argumentExpression)
      )
        name = parent.argumentExpression.text;
      if (!/^(?:PLATFORM|DOCUMENT_SERVER)_[A-Z0-9_]+$/.test(name ?? ''))
        throw new Error(
          'config.ts inventory requires literal PLATFORM_* or DOCUMENT_SERVER_* environment reads',
        );
      names.add(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return names;
}

// Compose interpolates values, not mapping keys. Preserve quoted # and ignore YAML comments.
function scalar(line) {
  let quote = '';
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== '') {
      if (quote === '"' && character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (['"', "'"].includes(character)) {
      quote = character;
    } else if (character === '#' && /^\s?$/.test(line.charAt(index - 1))) {
      line = line.slice(0, index);
      break;
    } else if ('[{'.includes(character) && line[index - 1] !== '$') {
      throw new Error('Compose inventory does not support flow collections');
    } else if (character === ':' && /^\s?$/.test(line.charAt(index + 1))) {
      start = index + 1;
    }
  }
  if (quote !== '') throw new Error('Compose inventory requires single-line scalar quoting');
  const value = line.slice(start);
  if (/^\s*[|>][\d+-]*\s*$/.test(value))
    throw new Error('Compose inventory does not support block scalars');
  return value;
}

// Literal values (such as fixed container names) are not interpolation and never count.
function composeReads() {
  const names = new Set();
  for (const line of readFileSync('deploy/compose.yml', 'utf8').split('\n')) {
    const value = scalar(line).replaceAll('$$', '');
    for (const match of value.matchAll(
      /\$(?:\{((?:DEPLOY|DOCUMENT_SERVER)_[A-Z0-9_]+)(?=[:?+\-}])|((?:DEPLOY|DOCUMENT_SERVER)_[A-Z0-9_]+))/g,
    ))
      names.add(match[1] ?? match[2]);
  }
  return names;
}

function compare(prefix, reads, example) {
  const consumed = new Set([...reads].filter((name) => name.startsWith(prefix)));
  const declared = new Set(Object.keys(example).filter((name) => name.startsWith(prefix)));
  const missing = [...consumed].filter((name) => !declared.has(name));
  const unused = [...declared].filter((name) => !consumed.has(name));
  for (const name of missing) process.stderr.write(`config inventory: undocumented ${name}\n`);
  for (const name of unused) process.stderr.write(`config inventory: unconsumed ${name}\n`);
  return missing.length === 0 && unused.length === 0;
}

try {
  const example = parseEnv(readFileSync('.env.example', 'utf8'));
  const compose = composeReads();
  const reads = platformReads();
  const platform = compare('PLATFORM_', reads, example);
  const deployment = compare('DEPLOY_', compose, example);
  // Shared inputs: consumed when either the platform reads or compose interpolates them.
  const documentServer = compare('DOCUMENT_SERVER_', new Set([...reads, ...compose]), example);
  if (!platform || !deployment || !documentServer) process.exitCode = 1;
  else
    process.stdout.write(
      'Configuration inventories match: PLATFORM_*, DEPLOY_* and DOCUMENT_SERVER_*\n',
    );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
