import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { record } from './container-start-docker-fixture.ts';
import { PROFILE_EDITOR_SERIALIZATION } from './managed-policy-profile.ts';

export interface ModelObserver {
  arm(input: Record<string, unknown>): void;
  observation(): unknown;
}

/** Only an invocation-owned employee profile changes; caller uses the real restart API. */
export async function installModelObserver(
  exec: (script: string) => string,
  name: 'permission-model' | 'office-model',
  initialControl: Record<string, unknown>,
): Promise<ModelObserver> {
  const sourceUrl =
    name === 'permission-model'
      ? new URL('./permission-model-observer.mjs', import.meta.url)
      : new URL('./office-model-observer.mjs', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  const module = `/data/home/${name}-observer.mjs`;
  const control = `/data/home/${name}-control.json`;
  const evidence = `/data/home/${name}-observation.json`;
  const maximum = name === 'office-model' ? 65536 : 16384;
  exec(`
import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const require=createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const profile='/data/home/profiles/web/cordis.patch.yml';
if(existsSync(${JSON.stringify(module)}))throw new Error('Observer already installed');
const bytes=readFileSync(profile,'utf8');
${PROFILE_EDITOR_SERIALIZATION}
editorDocument.contents.add(editorDocument.createNode({insert:[{id:${JSON.stringify(`dsh-team-${name}-proof`)},name:${JSON.stringify(module)},config:${JSON.stringify({ control, evidence })}}]}));
writeFileSync(${JSON.stringify(module)},${JSON.stringify(source)},{mode:0o600});
writeFileSync(${JSON.stringify(control)},${JSON.stringify(JSON.stringify(initialControl))},{mode:0o600});
writeFileSync(profile,String(editorDocument));
`);
  return {
    arm(input) {
      exec(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(control)},${JSON.stringify(JSON.stringify(input))},{mode:0o600});`,
      );
    },
    observation() {
      const value = record(
        JSON.parse(
          exec(`
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const evidence=readFileSync(${JSON.stringify(evidence)},'utf8');
if(evidence.length>${String(maximum)})throw new Error('Observer evidence exceeds bound');
process.stdout.write(JSON.stringify({hash:createHash('sha256').update(readFileSync(${JSON.stringify(module)})).digest('hex'),evidence:JSON.parse(evidence)}));
`),
        ),
      );
      if (value.hash !== hash) throw new Error('Model observer bytes changed');
      return value.evidence;
    },
  };
}
