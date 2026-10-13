import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';

const mounted: { root: Root; container: HTMLDivElement }[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  try {
    for (const { root, container } of mounted.splice(0)) {
      try {
        act(() => {
          root.unmount();
        });
      } finally {
        container.remove();
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

export interface RenderedAccount {
  view: HTMLDivElement;
  request: Mock<typeof fetch>;
  navigate: Mock<(path: string) => void>;
}

export function renderAccountPage(
  page: ReactNode,
  pathname: string,
  request = vi.fn<typeof fetch>(),
): RenderedAccount & { unmount: () => void } {
  const navigate = vi.fn<(path: string) => void>();
  vi.stubGlobal('fetch', request);
  // jsdom location is nonconfigurable; delegate every other property to the real DOM window.
  vi.stubGlobal(
    'window',
    new Proxy(window, {
      get(target, property): unknown {
        if (property === 'location') return { assign: navigate, pathname };
        const value: unknown = Reflect.get(target, property, target);
        return value;
      },
    }),
  );
  const view = document.createElement('div');
  document.body.append(view);
  const root = createRoot(view);
  const entry = { root, container: view };
  mounted.push(entry);
  act(() => {
    root.render(page);
  });
  return {
    view,
    request,
    navigate,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      mounted.splice(mounted.indexOf(entry), 1);
      view.remove();
    },
  };
}

export function element<T extends Element>(
  view: HTMLDivElement,
  selector: string,
  ctor: new () => T,
): T {
  const found = view.querySelector(selector);
  if (found === null) throw new Error(`Missing account element: ${selector}`);
  if (!(found instanceof ctor)) throw new Error(`Unexpected account element type: ${selector}`);
  return found;
}

export function change(input: HTMLInputElement, value: string): void {
  // The native setter bypasses React's value tracker so the real input event updates state.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (typeof descriptor?.set !== 'function') throw new Error('Missing native input value setter');
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function submit(view: HTMLDivElement): Event {
  // Dispatch through the real DOM/React event system; browser validation is covered by UI.
  const event = new Event('submit', { bubbles: true, cancelable: true });
  element(view, 'form', HTMLFormElement).dispatchEvent(event);
  return event;
}

export async function settleSubmit(view: HTMLDivElement): Promise<void> {
  await settle(() => {
    submit(view);
  });
}

export function createJsonReceipt(defaultBody: unknown) {
  return (body: unknown = defaultBody, status = 200): Response =>
    new Response(JSON.stringify(body), { status });
}

export async function settle(action?: () => void): Promise<void> {
  await act(async () => {
    action?.();
    await Promise.resolve();
  });
}

export async function renderSettledAccountPage(
  page: ReactNode,
  pathname: string,
  request: Mock<typeof fetch>,
) {
  const rendered = renderAccountPage(page, pathname, request);
  await settle();
  return rendered;
}

export function button(view: HTMLDivElement, text: string): HTMLButtonElement {
  const found = [...view.querySelectorAll('button')].find((entry) => entry.textContent === text);
  if (found === undefined) throw new Error(`Missing button ${text}`);
  return found;
}

export async function click(view: HTMLDivElement, text: string): Promise<void> {
  await settle(() => {
    button(view, text).click();
  });
}

export async function draft(view: HTMLDivElement, selector: string, value: string): Promise<void> {
  await settle(() => {
    change(element(view, selector, HTMLInputElement), value);
  });
}

export function holdResponseBody(response: Response): PromiseWithResolvers<ArrayBuffer> {
  const body = Promise.withResolvers<ArrayBuffer>();
  vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
  return body;
}

export async function finishResponseBody(
  body: PromiseWithResolvers<ArrayBuffer>,
  rejected: boolean,
  message: string,
): Promise<void> {
  await settle(() => {
    if (rejected) body.reject(new Error(message));
    else body.resolve(new ArrayBuffer(0));
  });
}
