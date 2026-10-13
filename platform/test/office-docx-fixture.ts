// Used inside the owned image as uid1001; never creates or repairs the Agent's file.
const READ_DOCX = String.raw`
import hashlib, io, json, os, stat, sys, zipfile
from docx import Document
from docx.oxml.ns import qn
path = sys.argv[1]
result = {'path': path, 'uid': os.geteuid(), 'status': 'unreadable'}
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('not regular')
        data = stream.read(1048577)
    # Bound decompression and output before parsing model-produced bytes.
    if len(data) > 1048576:
        raise ValueError('compressed size')
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        if sum(row.file_size for row in package.infolist()) > 4194304:
            raise ValueError('expanded size')
    document = Document(io.BytesIO(data))
    paragraphs = [''.join(node.text or '' for node in paragraph.iter(qn('w:t')))
                  for paragraph in document.element.body.iter(qn('w:p'))]
    if len(json.dumps(paragraphs, ensure_ascii=False).encode('utf8')) > 32768:
        raise ValueError('text size')
    result.update(status='parsed', bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), paragraphs=paragraphs)
except FileNotFoundError:
    result['status'] = 'missing'
except Exception:
    pass  # Only fixed failure classification crosses the model credential boundary.
print(json.dumps(result, ensure_ascii=False))
`;

export function officeDocxReadScript(path: string): string {
  return `import {spawnSync} from 'node:child_process';
const result=spawnSync('/usr/bin/python3',['-c',${JSON.stringify(READ_DOCX)},${JSON.stringify(path)}],{encoding:'utf8',timeout:10000,maxBuffer:65536});
if(result.error||result.status!==0)throw new Error('office-docx-observer');
process.stdout.write(result.stdout);`;
}
