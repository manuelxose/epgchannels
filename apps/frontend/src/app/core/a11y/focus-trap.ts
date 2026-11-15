/**
 * Modal drawer focus management (P3 / audit N6).
 *
 * `aria-modal="true"` is a promise to assistive technology: the rest of the
 * page is inert, Tab cannot leave the dialog, and closing returns focus to the
 * control that opened it. These helpers own that promise so it is unit-testable
 * independently of the component that renders the drawer.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hasAttribute('inert') || element.closest('[inert]')) {
      return false;
    }
    return isVisible(element);
  });
}

/**
 * Visibility check that stays honest without layout: a detached, `hidden` or
 * inline-hidden control is not focusable, while an attached control that simply
 * has no boxes yet (reactively hidden until measured) is still a real target.
 */
function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }
  if (element.hidden || element.closest('[hidden]')) {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== 'none' && style?.visibility !== 'hidden';
}

/**
 * The deepest focused element, looking through shadow roots (EmulatedEncapsulation
 * means our dialog lives in one, and `document.activeElement` then reports only
 * the host component).
 */
export function deepActiveElement(doc: Document = document): HTMLElement | null {
  let active: Element | null = doc.activeElement;
  while (active instanceof Element && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}

/**
 * Handles `keydown` inside a modal dialog.
 *
 * - `Escape` closes it (prevented so no outer handler also reacts);
 * - `Tab` / `Shift+Tab` wrap around the focusable children and never escape.
 *
 * `host` is the component element whose shadow root contains the dialog: focus
 * can sit on it, and that still counts as "inside" the modal. `focusRoot`
 * additionally holds any other tab stops (e.g. a scroll region) that belong to
 * the dialog but are not controls; the browser carries focus there, and the
 * next `Tab` must stay inside, so only `Shift+Tab` from there wraps to the last
 * control.
 *
 * Returns the action the caller must take, so the DOM side stays explicit.
 */
export function trapTabKey(
  event: { key: string; shiftKey: boolean; preventDefault(): void },
  dialog: HTMLElement,
  options: { readonly host?: HTMLElement; readonly focusRoot?: HTMLElement } = {},
): 'close' | 'wrapped' | 'none' {
  if (event.key === 'Escape') {
    event.preventDefault();
    return 'close';
  }
  if (event.key !== 'Tab') {
    return 'none';
  }
  const { host, focusRoot } = options;
  const focusable = focusableWithin(dialog);
  if (focusable.length === 0) {
    // Nothing to focus inside: keep focus on the dialog itself.
    event.preventDefault();
    dialog.focus();
    return 'wrapped';
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = deepActiveElement(dialog.ownerDocument);
  const onFocusRoot = focusRoot !== undefined && active === focusRoot;
  if (!event.shiftKey && onFocusRoot) {
    // The browser would leave the dialog from the scroll region: go to the first
    // control (native forward order afterwards is unchanged inside the dialog).
    event.preventDefault();
    first.focus();
    return 'wrapped';
  }
  if (event.shiftKey && onFocusRoot) {
    // There is nothing after the dialog to land on, so move forward deliberately
    // to the last control instead of letting the browser backtrack out of it.
    event.preventDefault();
    last.focus();
    return 'wrapped';
  }
  const inside = active !== null && (active === dialog || dialog.contains(active));
  if (!inside && active !== host && active !== null) {
    // Focus escaped (e.g. a background control focused programmatically): pull it
    // back instead of letting Tab continue outside the modal.
    event.preventDefault();
    first.focus();
    return 'wrapped';
  }
  if (event.shiftKey && (active === first || active === dialog || active === host || active === null)) {
    event.preventDefault();
    last.focus();
    return 'wrapped';
  }
  if (!event.shiftKey && active === last && !focusRoot) {
    event.preventDefault();
    first.focus();
    return 'wrapped';
  }
  return 'none';
}

/**
 * Marks everything outside `dialog` inert (and removes it again on restore).
 *
 * Works for a dialog rendered in a shadow root: `containers` lists the roots
 * that must keep interacting with the dialog — the owning component host plus
 * its ancestors. Everything else is made inert, in the document and inside the
 * shadow root, so neither Tab nor assistive technology can reach it.
 *
 * Returns the restore function; call it exactly once, on close.
 */
export function inertBackground(dialog: HTMLElement, ...containers: HTMLElement[]): () => void {
  const doc = dialog.ownerDocument;
  const protectedPath = new Set<Element>([dialog, ...containers]);
  const root = dialog.getRootNode();
  if (root instanceof ShadowRoot) {
    protectedPath.add(root.host);
    for (let node: Element | null = root.host; node; ) {
      protectedPath.add(node);
      node = node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null);
    }
  }
  const scopes = [doc.body, ...(root instanceof ShadowRoot ? [root] : [])];
  const touched: { element: HTMLElement; hadInert: boolean; ariaHidden: string | null }[] = [];

  const visit = (parent: HTMLElement | ShadowRoot): void => {
    for (const child of [...parent.children]) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }
      if (protectedPath.has(child)) {
        // Keep the path to the dialog interactive, but make its own non-path
        // children inert (the app shell around the stage).
        if (child === (containers[0] ?? null)) {
          visit(child);
        }
        continue;
      }
      if (child.contains(dialog)) {
        visit(child);
        continue;
      }
      touched.push({ element: child, hadInert: child.hasAttribute('inert'), ariaHidden: child.getAttribute('aria-hidden') });
      child.setAttribute('inert', '');
      child.setAttribute('aria-hidden', 'true');
    }
  };

  for (const scope of scopes) {
    visit(scope);
  }

  return () => {
    for (const entry of touched) {
      if (!entry.hadInert) {
        entry.element.removeAttribute('inert');
      }
      if (entry.ariaHidden === null) {
        entry.element.removeAttribute('aria-hidden');
      } else {
        entry.element.setAttribute('aria-hidden', entry.ariaHidden);
      }
    }
  };
}

/**
 * Locks page scrolling without losing the scroll position (iOS-safe: a fixed
 * body keeps the current offset instead of jumping to the top).
 */
export function lockScroll(win: Window = window): () => void {
  const body = win.document.body;
  const scrollY = win.scrollY;
  const previous = {
    overflow: body.style.overflow,
    position: body.style.position,
    top: body.style.top,
    width: body.style.width,
  };
  body.style.overflow = 'hidden';
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.width = '100%';
  return () => {
    body.style.overflow = previous.overflow;
    body.style.position = previous.position;
    body.style.top = previous.top;
    body.style.width = previous.width;
    win.scrollTo(0, scrollY);
  };
}

/**
 * Moves focus into the dialog (first focusable, or the dialog itself) and
 * returns the restore function for the element that had focus before. The
 * opener can live outside any shadow root, so the deep active element is used.
 */
export function focusFirst(dialog: HTMLElement): () => void {
  const doc = dialog.ownerDocument;
  const previous = deepActiveElement(doc);
  const target = focusableWithin(dialog)[0] ?? dialog;
  target.focus();
  return () => {
    if (previous && previous.isConnected) {
      previous.focus();
    }
  };
}
