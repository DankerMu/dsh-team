import { registerHooks } from 'node:module';
import { claimVerificationDockerObserver } from './verification-docker-generations.mjs';
import { trackVerificationDockerClient } from './verification-submissions.mjs';

const preload = new URL(import.meta.url);
const bootstrap = preload.searchParams.get('bootstrap');
const authority = preload.searchParams.get('authority');
if (!bootstrap || !authority || preload.searchParams.size !== 2)
  throw new Error('Docker observer startup authority missing');
const observer = claimVerificationDockerObserver(bootstrap, authority);
const originalUrl = new URL(observer.moduleUrl);
originalUrl.searchParams.set('dsh-team-original', observer.generation);
const bypass = originalUrl.href;

registerHooks({
  load(url, context, nextLoad) {
    if (url === bypass) {
      const loaded = nextLoad(observer.moduleUrl, context);
      if (loaded.format !== 'module' || loaded.source == null)
        throw new Error('Docker observer requires the original compiled module');
      return { ...loaded, shortCircuit: true };
    }
    if (url !== observer.moduleUrl) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `export * from ${JSON.stringify(bypass)};
import {createDockerClient as originalFactory,DockerHttpError} from ${JSON.stringify(bypass)};
import {observeDockerFactory} from ${JSON.stringify(import.meta.url)};
export function createDockerClient(...args){return observeDockerFactory(originalFactory,DockerHttpError,args);}`,
    };
  },
});

/** Called only by the exact-module hook; no source bytes or builtin HTTP behavior are changed. */
export function observeDockerFactory(factory, DockerHttpError, args) {
  if (
    typeof factory !== 'function' ||
    typeof DockerHttpError !== 'function' ||
    !(DockerHttpError.prototype instanceof Error) ||
    args[0] !== observer.socketPath
  )
    throw new Error('Docker observer factory or socket authority changed');
  const client = factory(...args);
  if (typeof client?.json !== 'function' || typeof client.logs !== 'function')
    throw new Error('Docker observer client interface unavailable');
  observer.initialize();
  return trackVerificationDockerClient(client, DockerHttpError, observer.submit);
}

process.once('exit', (code) => {
  if (code !== 0) return;
  try {
    observer.finish();
  } catch {
    // The reserved participant fence survives missing initialization or failed publication.
    process.exitCode = 1;
  }
});
