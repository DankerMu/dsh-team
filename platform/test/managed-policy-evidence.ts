import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MappedHostAcceptResult } from '../../scripts/probe-mapped-host.mjs';

export function managedPolicyEvidenceRoot(runId: string): string {
  return join(process.cwd(), '.run', 'issue32', `managed-policy-${runId}`);
}

export type ManagedPolicyStage = 'start' | 'control' | 'restart' | 'hash';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

const REVIEWED_HEAD = /^[0-9a-f]{40}$/;

function requireReviewedHead(): string {
  const reviewedHead = process.env.GITHUB_SHA ?? process.env.DSH_TEAM_REVIEWED_HEAD ?? '';
  if (!REVIEWED_HEAD.test(reviewedHead)) {
    throw new Error('Managed policy evidence requires an exact 40-hex reviewed head');
  }
  return reviewedHead;
}

function jsonValue(value: unknown, keys: readonly string[]): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      const allowed = jsonValue(item, keys);
      return allowed === undefined ? [] : [allowed];
    });
    return items;
  }
  if (typeof value !== 'object') return undefined;
  const record: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const allowed = jsonValue(Reflect.get(value, key), keys);
    if (allowed !== undefined) record[key] = allowed;
  }
  return record;
}

const BROWSER_KEYS = [
  'accepted',
  'initialized',
  'screenshot',
  'reload',
  'preservation',
  'ui',
  'host',
  'input',
  'workBound',
  'workBoundUnknown',
  'readiness',
  'bootRoster',
  'consoleErrors',
  'hostname',
  'languages',
  'navigatorLanguage',
  'lang',
  'notice',
  'editable',
  'workspaceChoice',
  'workspaceSelected',
  'workspaceLabel',
  'pickerOpen',
  'zhVisible',
  'enVisible',
  'chinese',
  'noNotice',
  'inputUsable',
  'typed',
  'cleared',
  'modelSend',
  'locale',
  'preference',
  'welcomeNoticeVersion',
  'workspace',
  'sessions',
  'available',
  'reason',
  'cwds',
  'path',
  'listed',
  'selected',
  'defaultModel',
  'exactModels',
  'general',
  'ids',
] as const;

const OBSERVATION_KEYS = [
  'models',
  'presets',
  'intranetAddress',
  'defaultModel',
  'catalog',
  'alphaContextWindow',
  'betaContextWindow',
  'id',
  'description',
  'toolNames',
  'readLimit',
] as const;

function allowlistedBrowser(value: unknown): Record<string, JsonValue> | undefined {
  const allowed = jsonValue(value, BROWSER_KEYS);
  if (typeof allowed !== 'object' || allowed === null || Array.isArray(allowed)) return undefined;
  return allowed;
}

export function browserEvidence(result: MappedHostAcceptResult): Record<string, JsonValue> {
  const allowed = allowlistedBrowser({
    accepted: result.accepted,
    initialized: result.initialized === true,
    screenshot: result.screenshot?.screenshot,
    reload: result.reload
      ? {
          accepted: result.reload.accepted,
          screenshot: result.reload.screenshot?.screenshot,
          initialized: result.reload.initialized === true,
          ui: result.reload.ui,
          host: result.reload.host,
          input: result.reload.input,
        }
      : undefined,
    preservation: result.preservation
      ? {
          general: result.preservation.general === true,
          listed: result.preservation.listed,
          selected: result.preservation.selected,
          defaultModel: result.preservation.defaultModel,
          exactModels: result.preservation.exactModels,
          screenshot: result.preservation.screenshot?.screenshot,
        }
      : undefined,
    ui: result.ui,
    host: result.host,
    input: result.input,
    workBound: result.workBound === true,
    workBoundUnknown: result.workBoundUnknown === true,
    readiness: result.readiness,
    bootRoster: result.bootRoster?.ids,
    consoleErrors: result.consoleErrors ?? [],
  });
  return allowed ?? {};
}

interface ManagedPolicyEvidenceFields {
  startPort?: number;
  restartPort?: number;
  startScreenshot?: string;
  restartScreenshot?: string;
  startObservation?: JsonValue;
  restartObservation?: JsonValue;
  controlObservation?: JsonValue;
  controlRejected?: true;
  startBrowser?: Record<string, JsonValue>;
  restartBrowser?: Record<string, JsonValue>;
}

interface ManagedPolicyEvidenceRecord extends ManagedPolicyEvidenceFields {
  imageId: string;
  runId: string;
  reviewedHead: string;
  failed?: true;
  failedStage?: ManagedPolicyStage;
}

interface ManagedPolicyEvidenceInput {
  startPort?: number;
  restartPort?: number;
  startScreenshot?: string;
  restartScreenshot?: string;
  startObservation?: unknown;
  restartObservation?: unknown;
  controlObservation?: unknown;
  controlRejected?: true;
  startBrowser?: Record<string, unknown>;
  restartBrowser?: Record<string, unknown>;
}

function allowlistedFields(fields: ManagedPolicyEvidenceInput): ManagedPolicyEvidenceFields {
  const acquired: ManagedPolicyEvidenceFields = {};
  if (typeof fields.startPort === 'number') acquired.startPort = fields.startPort;
  if (typeof fields.restartPort === 'number') acquired.restartPort = fields.restartPort;
  if (typeof fields.startScreenshot === 'string') acquired.startScreenshot = fields.startScreenshot;
  if (typeof fields.restartScreenshot === 'string') {
    acquired.restartScreenshot = fields.restartScreenshot;
  }
  const startObservation = jsonValue(fields.startObservation, OBSERVATION_KEYS);
  if (startObservation !== undefined) acquired.startObservation = startObservation;
  const restartObservation = jsonValue(fields.restartObservation, OBSERVATION_KEYS);
  if (restartObservation !== undefined) acquired.restartObservation = restartObservation;
  const controlObservation = jsonValue(fields.controlObservation, OBSERVATION_KEYS);
  if (controlObservation !== undefined) acquired.controlObservation = controlObservation;
  if (fields.controlRejected === true) acquired.controlRejected = true;
  const startBrowser = allowlistedBrowser(fields.startBrowser);
  if (startBrowser !== undefined) acquired.startBrowser = startBrowser;
  const restartBrowser = allowlistedBrowser(fields.restartBrowser);
  if (restartBrowser !== undefined) acquired.restartBrowser = restartBrowser;
  return acquired;
}

export interface ManagedPolicyEvidence {
  readonly path: string;
  record(fields: ManagedPolicyEvidenceInput): void;
  finish(): string;
  fail(stage?: ManagedPolicyStage): void;
}

export function createManagedPolicyEvidence(lifecycle: {
  readonly imageId: string;
  readonly runId: string;
}): ManagedPolicyEvidence {
  const evidence = managedPolicyEvidenceRoot(lifecycle.runId);
  mkdirSync(evidence, { recursive: true });
  const path = join(evidence, 'observations.json');
  const identity = {
    imageId: lifecycle.imageId,
    runId: lifecycle.runId,
    reviewedHead: requireReviewedHead(),
  };
  let acquired: ManagedPolicyEvidenceFields = {};
  const persist = (extra: { failed?: true; failedStage?: ManagedPolicyStage } = {}): string => {
    const summary: ManagedPolicyEvidenceRecord = { ...identity, ...acquired, ...extra };
    writeFileSync(path, JSON.stringify(summary));
    return JSON.stringify(summary);
  };
  persist();
  return {
    path,
    record(fields): void {
      acquired = { ...acquired, ...allowlistedFields(fields) };
      persist();
    },
    finish(): string {
      return persist();
    },
    fail(stage?: ManagedPolicyStage): void {
      persist({ failed: true, ...(stage === undefined ? {} : { failedStage: stage }) });
    },
  };
}
