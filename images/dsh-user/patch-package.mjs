// Build-time patches of released third-party packages: one pinned entry per package, one shared
// implementation. Usage: node patch-package.mjs <pin> <opt-root> <global-root>. Any drift (version,
// copies, location, input/output SHA-256, anchors of any target) refuses before writing; each target
// is replaced atomically, and a failed write puts the targets already written back. A refusal names
// only the first failed check.
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
const INJECT_HEAD = 'const inject = [\n\t"webServer",\n\t"sessions",\n\t';
/** The route's trust fence, anchored by its unique route path (the fence line itself repeats). */
const fence = (route, opening, service) =>
  `\t\t\tpath: "/sidebar/onlyoffice/${route}",\n\t\t\thandler: async (req, res) => {\n${opening}` +
  `\t\t\t\ttry {\n\t\t\t\t\tif (!isTrustedApiRequest(req, plugin.${service}.trustedHosts)) {`;
const WATCH_OPENING = '\t\t\t\tlet streaming = false;\n';

/** Pinned values per package; each replacement's original text must occur exactly once. */
export const PINS = {
  // dsh-sidebar-onlyoffice@0.2.0: the file-token secret and the document key derive from the
  // per-instance DSH_TEAM_ONLYOFFICE_FILE_SECRET instead of a public constant; without it nothing
  // is minted, verified, registered or derived, and the watch hub treats the file as absent.
  // DSH 0.2.1-rc.2 provides webStartup (with trustedHosts) instead of webRuntime, so the injected
  // service and its three trustedHosts reads are remapped; comments naming webRuntime stay.
  onlyoffice: {
    package: 'dsh-sidebar-onlyoffice',
    directory: 'dsh-sidebar-onlyoffice',
    version: '0.2.0',
    // SHA-256 of the published lib/index.js (npm tarball) and of the reviewed patched result.
    targets: [
      {
        target: 'lib/index.js',
        inputSha256: 'e2148f01c2740c464eb39eaf6b9547f773a7b1a172039e9554e03da617d4b29b',
        outputSha256: '30c3ffd21bda284e9daa205bd3f71ec08eeb61dfad999080608a9a81d49196ef',
      },
    ],
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
      [`${INJECT_HEAD}"webRuntime"\n];`, `${INJECT_HEAD}"webStartup"\n];`],
      ['const runtime = () => ctx.webRuntime;', 'const runtime = () => ctx.webStartup;'],
      [fence('config', '', 'webRuntime'), fence('config', '', 'webStartup')],
      [fence('watch', WATCH_OPENING, 'webRuntime'), fence('watch', WATCH_OPENING, 'webStartup')],
    ],
  },
  // dsh-better-sidebar@0.28.0: the file editor's canOpen also takes docx, xlsx and pptx while the
  // sidebar's own viewer table holds an enabled viewer declaring the extension (ONLYOFFICE when
  // Office is available); otherwise they stay with DSH's own preview, as released. lib/client.js
  // is the build DSH loads (exports["./client"]); lib/client-registry.js, the module-id build, is
  // patched identically so no unpatched variant is delivered.
  'better-sidebar': {
    package: 'dsh-better-sidebar',
    directory: 'dsh-better-sidebar',
    version: '0.28.0',
    // SHA-256 of each published file (npm tarball) and of its reviewed patched result.
    targets: [
      {
        target: 'lib/client.js',
        inputSha256: '53b70b1b5317205247c074b8121e1ececec1df2dc3771b0641f0a66b8fd127e1',
        outputSha256: 'dbe401917803729e1d89a6e8cf504c5f0ce46e07a41b424967293317a3e1aeb6',
      },
      {
        target: 'lib/client-registry.js',
        inputSha256: '9862678d65831b031a72b54e560f5ad3dd94f00403429072a4c0a75c52d0da85',
        outputSha256: 'ac9d9a748b775336747c03c734b1902432eace04efd0f96a01c7f18444559700',
      },
    ],
    replacements: [
      [
        'return file !== void 0 && !hostOwnedPath(file.path);',
        'return file !== void 0 && (!hostOwnedPath(file.path) || ["docx", "xlsx", "pptx"].some(' +
          '(ext) => file.path.toLowerCase().endsWith("." + ext) && service.getFileViewers().some(' +
          '(viewer) => viewer.exts?.includes(ext) === true && service.isViewerEnabled(viewer.id))));',
      ],
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

/** The failed check, or the directory of the single real copy at the expected place and version. */
function discoverCopy({ name, expected, version, roots }) {
  let copies;
  try {
    copies = roots.flatMap((root) => findCopies(root, name, []));
  } catch {
    return { check: 'discovery' };
  }
  if (copies.length !== 1) return { check: 'copy-count' };
  const [copy] = copies;
  if (copy.directory !== expected) return { check: 'location' };
  if (copy.version !== version) return { check: 'version' };
  return { directory: copy.directory };
}

/** The failed check, or the target's path, released source and reviewed patched text. */
function checkTarget(directory, { target, inputSha256, outputSha256 }, replacements) {
  const path = join(directory, target);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return { check: 'input-read' };
  }
  if (sha256(source) !== inputSha256) return { check: 'input-sha256' };
  const patched = replaceAll(source, replacements);
  if (patched === undefined) return { check: 'anchor' };
  if (sha256(patched) !== outputSha256) return { check: 'output-sha256' };
  return { path, source, patched };
}

/** Writes every checked target in order; on a failure, puts the ones already written back. */
function writeTargets(checked, write) {
  for (const [index, { path, patched }] of checked.entries()) {
    try {
      replaceFile(path, patched, write);
    } catch {
      for (const { path: written, source } of checked.slice(0, index)) {
        try {
          replaceFile(written, source, write);
        } catch {
          // A failed write-back still refuses `write`, which fails the image build and its layer.
        }
      }
      return 'write';
    }
  }
  return undefined;
}

/** The first failed check, or undefined once every target holds its reviewed output. */
function patchCheck(options, write) {
  const copy = discoverCopy(options);
  if (copy.check !== undefined) return copy.check;
  const checked = [];
  for (const target of options.targets) {
    const result = checkTarget(copy.directory, target, options.replacements);
    if (result.check !== undefined) return result.check;
    checked.push(result);
  }
  return writeTargets(checked, write);
}

/**
 * Patch every target of the one real copy of `name` (found by manifest name under `roots`, which
 * must be `expected`); `write(descriptor, text)` fills each temporary file and `stderr` takes the
 * refusal.
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
      targets: pin.targets,
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
