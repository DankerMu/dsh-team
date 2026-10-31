/**
 * In-image JavaScript statements deciding `engines.dsh` exactly as the released loader does:
 * the installed DSH version, DSH's own `semver` (declared by `dsh-app-boot`) and prerelease
 * participation. Self-contained for both CommonJS `node -e` and ESM probe scripts; defines
 * `dshInstalled` and `dshEnginesSatisfied(range)`.
 */
export const DSH_ENGINES_PRELUDE = `
const dshManifest='/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json';
const {createRequire:dshCreateRequire}=process.getBuiltinModule('node:module');
const dshBoot=dshCreateRequire(dshManifest).resolve('@deepseek-ai/dsh-app-boot/package.json');
const dshSemver=dshCreateRequire(dshBoot)('semver');
const dshInstalled=JSON.parse(process.getBuiltinModule('node:fs').readFileSync(dshManifest,'utf8')).version;
const dshEnginesSatisfied=(range)=>typeof range==='string'&&range.trim()!==''&&dshSemver.satisfies(dshInstalled,range,{includePrerelease:true});
`;
