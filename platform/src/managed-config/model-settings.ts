import type { Settings } from '../db/index.ts';
import { hasCompleteModelSettings } from './generate.ts';

/** Instance environment name carrying the stored model key; the overlay references only this name. */
const MODEL_API_KEY_ENV = 'DSH_TEAM_MODEL_API_KEY';

/** Canonical stored-settings view used by instance admission and the administrator probe. */
export function modelSnapshot(settings: Settings) {
  return {
    modelSettings: {
      baseURL: settings.modelBaseUrl,
      apiKeyEnv: MODEL_API_KEY_ENV,
      models: settings.models,
      defaultModel: settings.defaultModel,
    },
    modelKey: settings.modelApiKey,
  };
}

/** Overlay completeness, with key availability derived from the actual stored credential. */
export function hasCompleteModelSnapshot(snapshot: ModelSnapshot): boolean {
  return hasCompleteModelSettings({
    ...snapshot.modelSettings,
    apiKeyConfigured: snapshot.modelKey.trim() !== '',
  });
}

export type ModelSnapshot = ReturnType<typeof modelSnapshot>;
