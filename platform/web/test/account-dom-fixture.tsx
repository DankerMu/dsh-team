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

export function renderAccountPage(page: ReactNode, pathname: string): RenderedAccount {
  const request = vi.fn<typeof fetch>();
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
  mounted.push({ root, container: view });
  act(() => {
    root.render(page);
  });
  return { view, request, navigate };
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
  await act(async () => {
    submit(view);
    // Async act drains the fetch/JSON continuations and their resulting React state.
    await Promise.resolve();
  });
}
