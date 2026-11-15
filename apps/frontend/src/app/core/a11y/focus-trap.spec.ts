import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusableWithin, focusFirst, inertBackground, lockScroll, trapTabKey } from './focus-trap';

/**
 * P3 / audit N6: the schedule drawer declares `aria-modal="true"`, so it must
 * trap Tab, make the background inert, lock scrolling and restore focus on
 * close. These tests exercise the behaviour on a real DOM (jsdom).
 */
function buildDialog(): { dialog: HTMLElement; trigger: HTMLButtonElement; outside: HTMLElement } {
  document.body.innerHTML = '';
  const main = document.createElement('main');
  const trigger = document.createElement('button');
  trigger.textContent = 'Toda la programación';
  main.append(trigger);
  const dialog = document.createElement('section');
  dialog.setAttribute('role', 'dialog');
  dialog.tabIndex = -1;
  const close = document.createElement('button');
  close.textContent = 'Cerrar';
  const link = document.createElement('a');
  link.href = '#uno';
  link.textContent = 'Uno';
  const disabled = document.createElement('button');
  disabled.disabled = true;
  const hiddenTab = document.createElement('span');
  hiddenTab.tabIndex = -1;
  dialog.append(close, link, disabled, hiddenTab);
  document.body.append(main, dialog);
  return { dialog, trigger, outside: main };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusableWithin', () => {
  it('lists enabled, positively tabbable controls only', () => {
    const { dialog } = buildDialog();
    const labels = focusableWithin(dialog).map((element) => element.textContent);
    expect(labels).toEqual(['Cerrar', 'Uno']);
  });

  it('skips controls inside an inert subtree', () => {
    const { dialog } = buildDialog();
    dialog.setAttribute('inert', '');
    expect(focusableWithin(dialog)).toHaveLength(0);
    dialog.removeAttribute('inert');
  });
});

describe('trapTabKey', () => {
  it('wraps forward from the last control to the first', () => {
    const { dialog } = buildDialog();
    const [first, last] = focusableWithin(dialog);
    last.focus();
    const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    expect(trapTabKey(event, dialog)).toBe('wrapped');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it('wraps backward from the first control to the last', () => {
    const { dialog } = buildDialog();
    const [first, last] = focusableWithin(dialog);
    first.focus();
    const event = { key: 'Tab', shiftKey: true, preventDefault: vi.fn() };
    expect(trapTabKey(event, dialog)).toBe('wrapped');
    expect(document.activeElement).toBe(last);
  });

  it('leaves intermediate Tab presses to the browser', () => {
    const { dialog } = buildDialog();
    focusableWithin(dialog)[0].focus();
    const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    expect(trapTabKey(event, dialog)).toBe('none');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('closes on Escape and consumes the key', () => {
    const { dialog } = buildDialog();
    const event = { key: 'Escape', shiftKey: false, preventDefault: vi.fn() };
    expect(trapTabKey(event, dialog)).toBe('close');
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('keeps focus on the dialog when it holds no focusable control', () => {
    document.body.innerHTML = '';
    const dialog = document.createElement('section');
    dialog.tabIndex = -1;
    document.body.append(dialog);
    const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    expect(trapTabKey(event, dialog)).toBe('wrapped');
    expect(document.activeElement).toBe(dialog);
  });
});

describe('inertBackground', () => {
  it('marks siblings inert and restores their exact previous state', () => {
    const { dialog, outside } = buildDialog();
    outside.setAttribute('aria-hidden', 'false');
    const restore = inertBackground(dialog);
    expect(outside.hasAttribute('inert')).toBe(true);
    expect(outside.getAttribute('aria-hidden')).toBe('true');
    expect(dialog.hasAttribute('inert')).toBe(false);

    restore();
    expect(outside.hasAttribute('inert')).toBe(false);
    expect(outside.getAttribute('aria-hidden')).toBe('false');
  });

  it('never removes an inert attribute it did not add', () => {
    const { dialog, outside } = buildDialog();
    outside.setAttribute('inert', '');
    const restore = inertBackground(dialog);
    restore();
    expect(outside.hasAttribute('inert')).toBe(true);
  });
});

describe('lockScroll', () => {
  it('pins the body and restores the previous inline styles and scroll offset', () => {
    const scrollTo = vi.fn();
    const fakeWindow = { document, scrollY: 320, scrollTo } as unknown as Window;
    document.body.style.overflow = 'auto';
    const restore = lockScroll(fakeWindow);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-320px');

    restore();
    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.position).toBe('');
    expect(document.body.style.top).toBe('');
    expect(scrollTo).toHaveBeenCalledWith(0, 320);
  });
});

describe('focusFirst', () => {
  it('focuses the first control and restores the opener on close', () => {
    const { dialog, trigger } = buildDialog();
    trigger.focus();
    const restore = focusFirst(dialog);
    expect(document.activeElement).toBe(focusableWithin(dialog)[0]);

    restore();
    expect(document.activeElement).toBe(trigger);
  });

  it('falls back to the dialog itself when it holds no control', () => {
    document.body.innerHTML = '';
    const dialog = document.createElement('section');
    dialog.tabIndex = -1;
    document.body.append(dialog);
    focusFirst(dialog);
    expect(document.activeElement).toBe(dialog);
  });

  it('does not throw when the opener was removed from the document', () => {
    const { dialog, trigger } = buildDialog();
    trigger.focus();
    const restore = focusFirst(dialog);
    trigger.remove();
    expect(() => restore()).not.toThrow();
  });
});
