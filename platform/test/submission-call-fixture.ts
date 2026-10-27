import { trackVerificationDockerClient } from '../../scripts/verification-submissions.mjs';
import { DockerHttpError, type DockerClient } from '../src/orchestrator/index.ts';

/** A mutation issued after an await: only the async stack still names the awaiting test. */
export async function awaitedMutation(client: DockerClient, path: string): Promise<unknown> {
  await Promise.resolve();
  return client.json('POST', path);
}

/** Constructs the tracked client from a timer, so only this fixture is on its stack. */
export function trackedFromTimer(raw: DockerClient): Promise<DockerClient> {
  const tracked = Promise.withResolvers<DockerClient>();
  setImmediate(() => {
    tracked.resolve(trackVerificationDockerClient(raw, DockerHttpError));
  });
  return tracked.promise;
}
