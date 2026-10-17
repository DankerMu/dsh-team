import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Expected one Debian source path');
const source = readFileSync(path, 'utf8');
const original = /^URIs: http:\/\/deb\.debian\.org\/debian$/gm;
if (source.match(original)?.length !== 1) throw new Error('Unexpected Debian source layout');
writeFileSync(path, source.replace(original, 'URIs: http://mirrors.tuna.tsinghua.edu.cn/debian'));
