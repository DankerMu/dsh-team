// @ts-check
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const name = 'dsh-team-office-docx-construction';
export const inject = ['tools', 'shell', 'sandboxPolicy'];
const STYLES = new Set(['title', 'heading1', 'heading2', 'normal']);
const MAX_TEXT_BYTES = 32768;
const MAX_DOCX_BYTES = 1048576;
const MAX_RECEIPT_BYTES = 16384;

// Only this fixed program enters the shell. User paths and prose travel on stdin.
// Directory descriptors and no-follow opens anchor traversal; link publishes a
// complete private file atomically without replacing any existing destination.
const PROGRAM = `import hashlib,io,json,os,secrets,signal,sys
from docx import Document

def require(condition,message):
    if not condition: raise ValueError(message)

def interrupted(number,frame):
    raise InterruptedError("Construction cancelled")

signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
raw=sys.stdin.buffer.read(65537)
require(len(raw)<=65536,"Construction input exceeds its byte limit")
s=json.loads(raw)
require(isinstance(s,dict) and set(s)=={"cwd","path","paragraphs"},"Invalid construction input")
cwd=s["cwd"];path=s["path"];paragraphs=s["paragraphs"]
require(isinstance(cwd,str) and os.path.isabs(cwd),"Session workspace must be absolute")
require(isinstance(path,str) and os.path.isabs(path) and len(path.encode("utf-8"))<=4096,"Invalid destination")
require("\\x00" not in cwd and "\\x00" not in path,"NUL is not permitted in paths")
require(".." not in cwd.split("/") and ".." not in path.split("/"),"Path traversal is not permitted")
cwd=os.path.normpath(cwd);path=os.path.normpath(path)
require(os.path.commonpath([cwd,path])==cwd and path!=cwd,"Destination must be inside the Session workspace")
require(isinstance(paragraphs,list) and 1<=len(paragraphs)<=64,"Expected 1 to 64 paragraphs")
styles={"title":"Title","heading1":"Heading 1","heading2":"Heading 2","normal":"Normal"}
for p in paragraphs:
    require(isinstance(p,dict) and "text" in p and set(p)<= {"text","style"},"Invalid paragraph fields")
    require(isinstance(p["text"],str) and len(p["text"])<=4096,"Paragraph text exceeds its character limit")
    require("style" not in p or isinstance(p["style"],str) and p["style"] in styles,"Unsupported paragraph style")
texts=json.dumps([p["text"] for p in paragraphs],ensure_ascii=False,separators=(",",":"))
require(len(texts.encode("utf-8"))<=32768,"Paragraph text exceeds its serialized byte limit")
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
directory=os.open("/",flags)
temporary=None
try:
    components=[part for part in cwd.split("/") if part]
    parts=os.path.relpath(path,cwd).split("/")
    for component in components+parts[:-1]:
        next_directory=os.open(component,flags,dir_fd=directory)
        os.close(directory);directory=next_directory
    target=parts[-1]
    try:
        os.stat(target,dir_fd=directory,follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("Destination already exists; build_docx is create-only")
    document=Document()
    for p in paragraphs:
        document.add_paragraph(p["text"],style=styles[p.get("style","normal")])
    buffer=io.BytesIO();document.save(buffer);data=buffer.getvalue()
    require(1<=len(data)<=1048576,"Constructed DOCX exceeds its byte limit")
    digest=hashlib.sha256(data).hexdigest()
    candidate=".build-docx-"+secrets.token_hex(16)
    fd=os.open(candidate,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
    temporary=candidate
    with os.fdopen(fd,"wb") as output:
        output.write(data);output.flush();os.fsync(output.fileno())
    os.link(temporary,target,src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
    os.unlink(temporary,dir_fd=directory);temporary=None
    print(json.dumps({"path":path,"bytes":len(data),"sha256":digest,"uid":os.getuid()},ensure_ascii=False))
finally:
    if temporary is not None:
        try: os.unlink(temporary,dir_fd=directory)
        except FileNotFoundError: pass
    os.close(directory)
`;

/** @param {unknown} value @param {string} label */
function object(value, label) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} input */
function paragraphs(input) {
  assert(
    Array.isArray(input) && input.length >= 1 && input.length <= 64,
    'Expected 1 to 64 paragraphs',
  );
  const blocks = input.map((value) => {
    const block = object(value, 'Paragraph');
    assert(
      Object.keys(block).every((key) => key === 'text' || key === 'style'),
      'Unknown paragraph property',
    );
    assert(
      typeof block.text === 'string' && block.text.length <= 8192 && [...block.text].length <= 4096,
      'Paragraph text must contain at most 4096 Unicode code points',
    );
    assert(
      !Object.hasOwn(block, 'style') ||
        (typeof block.style === 'string' && STYLES.has(block.style)),
      'Unsupported paragraph style',
    );
    return block;
  });
  assert(
    Buffer.byteLength(JSON.stringify(blocks.map((block) => block.text))) <= MAX_TEXT_BYTES,
    'Serialized paragraph text exceeds 32768 UTF-8 bytes',
  );
  return blocks;
}

/** @param {string} cwd @param {string} path */
async function destination(cwd, path) {
  assert(
    isAbsolute(cwd) && !cwd.includes('\0') && !cwd.split(sep).includes('..'),
    'Session workspace must be an absolute non-traversing path',
  );
  assert(
    path.length > 0 && !path.includes('\0') && !path.split(sep).includes('..'),
    'Destination must not be empty or contain NUL or traversal',
  );
  const target = resolve(cwd, path);
  const within = relative(cwd, target);
  assert(
    within !== '' && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`),
    'Destination must be inside the Session workspace',
  );
  assert(Buffer.byteLength(target) <= 4096, 'Destination exceeds 4096 UTF-8 bytes');
  /** @type {string} */
  let parent = sep;
  for (const component of dirname(target).split(sep).filter(Boolean)) {
    parent = join(parent, component);
    const info = await lstat(parent);
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      'Destination ancestors must be real directories',
    );
  }
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return target;
    throw error;
  }
  throw new Error('Destination already exists; build_docx is create-only');
}

/** @param {string} text @param {string} path */
function receipt(text, path) {
  assert(
    Buffer.byteLength(text) <= MAX_RECEIPT_BYTES,
    'Construction receipt exceeds its byte limit',
  );
  const value = object(/** @type {unknown} */ (JSON.parse(text)), 'Construction receipt');
  assert(
    Object.keys(value).length === 4 &&
      Object.keys(value).every((key) => ['path', 'bytes', 'sha256', 'uid'].includes(key)),
    'Invalid construction receipt fields',
  );
  assert(value.path === path, 'Construction receipt destination does not match the request');
  assert(
    typeof value.bytes === 'number' &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 1 &&
      value.bytes <= MAX_DOCX_BYTES,
    'Invalid constructed byte count',
  );
  assert(
    typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256),
    'Invalid construction digest',
  );
  assert(
    typeof value.uid === 'number' && Number.isSafeInteger(value.uid) && value.uid >= 0,
    'Invalid construction uid',
  );
  return { path, bytes: value.bytes, sha256: value.sha256, uid: value.uid };
}

/** @param {import('./docx-construction.types.js').Context} ctx */
export function apply(ctx) {
  ctx.tools.register({
    name: 'build_docx',
    description:
      'Create a new DOCX inside the Session workspace from ordered text/style paragraphs. Existing destinations are never replaced.',
    parameters: {
      type: 'object',
      required: ['path', 'paragraphs'],
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'New workspace destination; at most 4096 UTF-8 bytes.',
        },
        paragraphs: {
          type: 'array',
          description: '1–64 paragraphs; serialized text array at most 32768 UTF-8 bytes.',
          items: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', description: 'At most 4096 Unicode code points.' },
              style: { type: 'string', enum: [...STYLES] },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['path', 'bytes', 'sha256', 'uid'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          // rc.2 accepts structural JSON Schema only; receipt() enforces bounds.
          bytes: { type: 'integer' },
          sha256: { type: 'string' },
          uid: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Constructed ${value.path} (${value.bytes} bytes).` },
      ],
      presentationMeta: (_args, value) => value,
    },
    async execute(input, exec) {
      exec.signal.throwIfAborted();
      const args = object(input, 'Construction arguments');
      assert(
        Object.keys(args).every((key) => key === 'path' || key === 'paragraphs'),
        'Unknown construction argument',
      );
      assert(typeof args.path === 'string', 'Destination path must be a string');
      const blocks = paragraphs(args.paragraphs);
      const cwd = exec.agent?.session.header.cwd;
      assert(typeof cwd === 'string', 'Construction requires a Session workspace');
      const path = await destination(cwd, args.path);
      exec.signal.throwIfAborted();
      assert(exec.agent, 'Construction requires an Agent');
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
      const spec = ctx.shell.resolve({
        command: `/usr/bin/python3 -I -c '${PROGRAM}'`,
        stdin: JSON.stringify({ cwd, path, paragraphs: blocks }),
        workdir: cwd,
        timeoutMs: 15000,
        onExpiry: 'kill',
        stdoutMaxBytes: MAX_RECEIPT_BYTES,
        sandboxPolicy: policy,
        signal: exec.signal,
      });
      exec.signal.throwIfAborted();
      const result = await (await ctx.shell.execute(spec)).result();
      exec.signal.throwIfAborted();
      if (result.aborted) throw new DOMException('Construction cancelled', 'AbortError');
      assert(
        result.exitCode === 0 &&
          !result.timedOut &&
          !result.sandbox?.denied &&
          !result.sandbox?.runnerFailed,
        'Native DOCX construction failed or was denied',
      );
      assert(!result.stdout.truncated, 'Construction receipt was truncated');
      return receipt(result.stdout.text, path);
    },
  });
}
