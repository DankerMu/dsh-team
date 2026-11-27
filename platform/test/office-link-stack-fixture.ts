import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  docxCommand,
  documentServerReady,
  officeHintsLine,
  officeHintsScenario,
  openHinted,
  serviceWorkerRefused,
} from './office-hints-stack-fixture.ts';
import type { OfficeHintsEvidence } from './office-hints-stack-fixture.ts';
import { withWorkFiles } from './sidebar-archive-stack-fixture.ts';
import type { ArchiveEntry, ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { converseInWorkbench, element, scrubbedEvidence, until } from './stack-browser-fixture.ts';
import type { StackBrowserEvidence } from './stack-browser-fixture.ts';

const NAME = '工作通知.docx';
const PARAGRAPH = '对话链接探针：只打开，不编辑。';
/** The owned provider's one scripted reply: exactly a session-relative markdown file link. */
export const ownedLink = () => ({
  marker: `stack-link-${randomUUID()}`,
  reply: `[${NAME}](${NAME})`,
});
// Released dsh-web-frontend 0.2.1-rc.2 (`pw`, `iU`): once streaming ends, a link whose destination
// parses as a path renders as a button titled with that path, calling the chat view's openFile.
const LINK = `document.querySelector('[data-chat-flow] button[title=${JSON.stringify(NAME)}]')`;
const CONFIG = '/sidebar/onlyoffice/config';

export interface OfficeLinkLane extends ArchiveLane {
  readonly link: ReturnType<typeof ownedLink>;
}

interface OfficeLinkEvidence {
  readonly browser: StackBrowserEvidence;
  readonly file: ArchiveEntry;
  /** Every `path` the editor's config requests carried. */
  readonly paths: readonly string[];
}

async function officeLink(lane: OfficeLinkLane): Promise<OfficeLinkEvidence> {
  const { exec, session, link } = lane;
  const start = await lane.provider();
  const file = JSON.parse(await exec(docxCommand(NAME, PARAGRAPH))) as ArchiveEntry;
  expect(file.name).toBe(NAME);
  await documentServerReady(lane);
  const paths: string[] = [];
  const browser = await converseInWorkbench({
    ...session,
    directory: join(session.directory, 'office-link'),
    message: `${link.marker} 请回复通知文件的链接`,
    // The transcript shows the link's label, never its markdown.
    reply: NAME,
    turnComplete: () =>
      until(
        async () => Number((await lane.provider()).links) > Number(start.links),
        session.timeout,
        'office link turn',
      ),
    after: async (page, shoot) => {
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === CONFIG) paths.push(url.searchParams.get('path') ?? '<none>');
      });
      const target = async () => {
        await until(async () => (await element(page, LINK)) !== null, session.timeout, 'link');
        return element(page, LINK);
      };
      await openHinted(page, shoot, session, NAME, 'office-link-open', undefined, target);
    },
  });
  expect(paths.length, 'Editor config requested').toBeGreaterThan(0);
  expect(new Set(paths), 'Config path as the link gave it').toEqual(new Set([NAME]));
  const after: unknown = JSON.parse(await exec(docxCommand(NAME)));
  expect(after, 'Office link file unchanged by opening it').toEqual(file);
  const shown = scrubbedEvidence(browser);
  const refusal = serviceWorkerRefused(browser.consoleErrors, session.base);
  expect(refusal, `consoleErrors ${JSON.stringify(shown.consoleErrors)}`).toBe(true);
  expect(shown).toMatchObject({
    screenshots: ['login.png', 'workbench.png', 'reply.png', 'office-link-open.png'],
    ...{ pageErrors: [], failedRequests: [], externalRequests: [] },
  });
  return { browser, file, paths };
}

/**
 * #760: the Agent's reply `[工作通知.docx](工作通知.docx)` in the conversation opens the DOCX in the
 * ONLYOFFICE editor with the session-relative path the link carries; the bytes stay unchanged.
 */
const officeLinkScenario = (lane: OfficeLinkLane): Promise<OfficeLinkEvidence> =>
  withWorkFiles(lane, [NAME], 'Office link', () => officeLink(lane));

export type OfficeHintsWithLink = OfficeHintsEvidence & { readonly link: OfficeLinkEvidence };

/** The hints lane (#439), then the link lane on the same editor; the link rides on its line. */
export async function officeHintsWithLink(lane: OfficeLinkLane): Promise<OfficeHintsWithLink> {
  const hints = await officeHintsScenario(lane);
  return { ...hints, link: await officeLinkScenario(lane) };
}

/** The hints line, with the link's file, config paths, screenshots and unload sources as `link`. */
export function officeHintsWithLinkLine(evidence: OfficeHintsWithLink | undefined) {
  if (evidence === undefined) throw new Error('Office hints evidence missing');
  const { browser, file, paths } = evidence.link;
  const { screenshots, unloadViolations } = browser;
  return { ...officeHintsLine(evidence), link: { ...file, paths, screenshots, unloadViolations } };
}
