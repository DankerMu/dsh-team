// Build-time patches of released third-party packages: one pinned entry per package, one shared
// implementation. Usage: node patch-package.mjs <pin> <opt-root> <global-root>. Any drift (version,
// copies, location, input/output SHA-256, anchors) refuses before writing; the target is replaced
// atomically or left byte-for-byte unchanged. A refusal names only the failed check.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNAVAILABLE = 'throw new Error("onlyoffice: file token secret unavailable");';
// The released key input, unchanged: host, path, size and mtime joined by NUL.
const KEY_INPUT = '.update(`${host}\\0${path}\\0${String(size)}\\0${String(mtimeMs)}`)';
const KEY_SIGNATURE = 'function documentKey(host, path, size, mtimeMs) {\n';
const MINT_SIGNATURE = 'function mintFileToken(claims, secret) {\n';
const VERIFY_SIGNATURE =
  'function verifyFileToken(token, secret, now = Math.floor(Date.now() / 1e3)) {\n';
const WATCH_SIGNATURE = 'async function signatureOf(host, path) {\n';

/** Pinned values per package; each replacement's original text must occur exactly once. */
export const PINS = {
  // dsh-sidebar-onlyoffice@0.2.0: the file-token secret and the document key derive from the
  // per-instance DSH_TEAM_ONLYOFFICE_FILE_SECRET instead of a public constant; without it nothing
  // is minted, verified, registered or derived, and the watch hub treats the file as absent.
  onlyoffice: {
    package: 'dsh-sidebar-onlyoffice',
    directory: 'dsh-sidebar-onlyoffice',
    version: '0.2.0',
    target: 'lib/index.js',
    // SHA-256 of the published lib/index.js (npm tarball) and of the reviewed patched result.
    inputSha256: 'e2148f01c2740c464eb39eaf6b9547f773a7b1a172039e9554e03da617d4b29b',
    outputSha256: 'd7755d3baa54d4f4865a10ef5e88b63bd18c6484d764246a38f1469f9020f4c7',
    replacements: [
      [
        'const FILE_TOKEN_SECRET = "dsh-sidebar-onlyoffice/file-token/v1";',
        'const FILE_TOKEN_SECRET = process.env.DSH_TEAM_ONLYOFFICE_FILE_SECRET ?? "";',
      ],
      [
        `${KEY_SIGNATURE}\treturn createHash("sha256")${KEY_INPUT}.digest("hex");\n}`,
        `${KEY_SIGNATURE}\tif (FILE_TOKEN_SECRET === "") ${UNAVAILABLE}\n` +
          `\treturn createHmac("sha256", FILE_TOKEN_SECRET)${KEY_INPUT}.digest("hex");\n}`,
      ],
      [MINT_SIGNATURE, `${MINT_SIGNATURE}\tif (secret === "") ${UNAVAILABLE}\n`],
      [
        VERIFY_SIGNATURE,
        `${VERIFY_SIGNATURE}\tif (secret === "") return {\n\t\tok: false,\n\t\treason: "bad-signature"\n\t};\n`,
      ],
      [WATCH_SIGNATURE, `${WATCH_SIGNATURE}\tif (FILE_TOKEN_SECRET === "") return null;\n`],
    ],
  },
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The parsed real `package.json` of `directory` when it mentions `name`; undefined otherwise. */
function candidateManifest(directory, name) {
  const manifest = readdirSync(directory, { withFileTypes: true }).find(
    (entry) => entry.name === 'package.json' && entry.isFile(),
  );
  if (manifest === undefined) return undefined;
  const text = readFileSync(join(directory, 'package.json'), 'utf8');
  // Unrelated packages may ship deliberately malformed manifests; only a candidate is parsed.
  return text.includes(name) ? JSON.parse(text) : undefined;
}

/** Real directories only: a symbolic link is neither followed nor counted. */
function findCopies(directory, name, found) {
  const manifest = candidateManifest(directory, name);
  if (manifest?.name === name) found.push({ directory, version: manifest.version });
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) findCopies(join(directory, entry.name), name, found);
  }
  return found;
}

/** Each original occurs exactly once; undefined otherwise. */
function replaceAll(source, replacements) {
  let text = source;
  for (const [original, replacement] of replacements) {
    const parts = text.split(original);
    if (parts.length !== 2) return undefined;
    text = parts.join(replacement);
  }
  return text;
}

/** Same-directory temporary file and rename, keeping mode and owner of the replaced file. */
function replaceFile(target, text, write) {
  const { mode, uid, gid } = statSync(target);
  const temporary = `${target}.${String(process.pid)}.patch.tmp`;
  // `wx` never adopts an existing path; only a file this run created is removed on failure.
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      write(descriptor, text);
    } finally {
      closeSync(descriptor);
    }
    chownSync(temporary, uid, gid);
    chmodSync(temporary, mode & 0o7777);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The failed check, or undefined once the single real copy's target holds the reviewed output. */
function patchCheck(options, write) {
  const { name, expected, version, target, inputSha256, outputSha256, replacements, roots } =
    options;
  let copies;
  try {
    copies = roots.flatMap((root) => findCopies(root, name, []));
  } catch {
    return 'discovery';
  }
  if (copies.length !== 1) return 'copy-count';
  const [copy] = copies;
  if (copy.directory !== expected) return 'location';
  if (copy.version !== version) return 'version';
  const path = join(copy.directory, target);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return 'input-read';
  }
  if (sha256(source) !== inputSha256) return 'input-sha256';
  const patched = replaceAll(source, replacements);
  if (patched === undefined) return 'anchor';
  if (sha256(patched) !== outputSha256) return 'output-sha256';
  try {
    replaceFile(path, patched, write);
  } catch {
    return 'write';
  }
  return undefined;
}

/**
 * Patch the one real copy of `name` (found by manifest name under `roots`, which must be
 * `expected`); `write(descriptor, text)` fills the temporary file and `stderr` takes the refusal.
 * @returns the process exit status.
 */
export function patchPackage(options, io) {
  const { write = (descriptor, text) => writeFileSync(descriptor, text), stderr } = io;
  const check = patchCheck(options, write);
  if (check === undefined) return 0;
  stderr(`patch-package: refused: ${check}\n`);
  return 1;
}

/** `argv`: pin name, the /opt/dsh-team root (holding the expected copy) and the npm global root. */
export function main(argv, stderr, pins = PINS) {
  const [pinName, optRoot, globalRoot] = argv;
  if (argv.length !== 3) {
    stderr('patch-package: refused: usage\n');
    return 1;
  }
  const pin = Object.hasOwn(pins, pinName) ? pins[pinName] : undefined;
  if (pin === undefined) {
    stderr('patch-package: refused: unknown-package\n');
    return 1;
  }
  return patchPackage(
    {
      name: pin.package,
      expected: join(optRoot, pin.directory),
      version: pin.version,
      target: pin.target,
      inputSha256: pin.inputSha256,
      outputSha256: pin.outputSha256,
      replacements: pin.replacements,
      roots: [optRoot, globalRoot],
    },
    { stderr },
  );
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2), (text) => process.stderr.write(text));
}
