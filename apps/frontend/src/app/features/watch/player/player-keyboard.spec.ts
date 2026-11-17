import { describe, expect, it } from 'vitest';
import {
  clampVolume,
  commandFor,
  isTypingTarget,
  resolvePlayerCommand,
  shouldHandleCommand,
  VOLUME_STEP,
} from './player-keyboard';

/** Minimal stand-in for a KeyboardEvent, which jsdom does not always give us. */
function key(
  value: string,
  options: { target?: unknown; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  return {
    key: value,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
    target: (options.target ?? null) as EventTarget | null,
  } as unknown as KeyboardEvent;
}

function element(tagName: string, extra: Record<string, unknown> = {}): EventTarget {
  const role = typeof extra['role'] === 'string' ? (extra['role'] as string) : undefined;
  return {
    tagName,
    isContentEditable: false,
    getAttribute: (name: string) => (name === 'role' ? role : null),
    ...extra,
  } as unknown as EventTarget;
}

describe('commandFor', () => {
  it('maps the play, mute, fullscreen and live shortcuts in both cases', () => {
    expect(commandFor(key(' '))).toBe('toggle-play');
    expect(commandFor(key('k'))).toBe('toggle-play');
    expect(commandFor(key('K'))).toBe('toggle-play');
    expect(commandFor(key('m'))).toBe('toggle-mute');
    expect(commandFor(key('M'))).toBe('toggle-mute');
    expect(commandFor(key('f'))).toBe('toggle-fullscreen');
    expect(commandFor(key('F'))).toBe('toggle-fullscreen');
    expect(commandFor(key('l'))).toBe('seek-live');
  });

  it('maps the arrow keys to volume', () => {
    expect(commandFor(key('ArrowUp'))).toBe('volume-up');
    expect(commandFor(key('ArrowDown'))).toBe('volume-down');
  });

  it('leaves every other key to the browser', () => {
    expect(commandFor(key('Tab'))).toBeUndefined();
    expect(commandFor(key('Enter'))).toBeUndefined();
    expect(commandFor(key('Escape'))).toBeUndefined();
    expect(commandFor(key('z'))).toBeUndefined();
  });

  it('ignores modifier combinations so browser and assistive shortcuts still work', () => {
    expect(commandFor(key('m', { ctrlKey: true }))).toBeUndefined();
    expect(commandFor(key('f', { altKey: true }))).toBeUndefined();
    expect(commandFor(key('k', { metaKey: true }))).toBeUndefined();
  });

  it('never steals keys while the user is typing in a field', () => {
    expect(commandFor(key('m', { target: element('INPUT', { type: 'search' }) }))).toBeUndefined();
    expect(commandFor(key(' ', { target: element('INPUT', { type: 'text' }) }))).toBeUndefined();
    expect(commandFor(key('ArrowDown', { target: element('SELECT', { type: 'select-one' }) }))).toBeUndefined();
    expect(commandFor(key('m', { target: element('TEXTAREA') }))).toBeUndefined();
  });

  it('lets the volume slider keep its arrow keys', () => {
    expect(commandFor(key('ArrowUp', { target: element('INPUT', { type: 'range' }) }))).toBeUndefined();
  });

  it('does not double-handle Space on a focused button or link', () => {
    expect(commandFor(key(' ', { target: element('BUTTON', { type: 'button' }) }))).toBeUndefined();
    expect(commandFor(key(' ', { target: element('A') }))).toBeUndefined();
    // But K still works there: only Space is the button's own activation key.
    expect(commandFor(key('k', { target: element('BUTTON', { type: 'button' }) }))).toBe('toggle-play');
  });
});

describe('isTypingTarget', () => {
  it('is false for null and for ordinary elements', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(element('DIV'))).toBe(false);
  });

  it('is true for content-editable surfaces', () => {
    expect(isTypingTarget(element('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('is true for our own composite widgets (menus, listboxes, sliders)', () => {
    for (const role of ['listbox', 'menu', 'menuitem', 'combobox', 'slider', 'tab', 'dialog']) {
      expect(isTypingTarget(element('DIV', { role }))).toBe(true);
    }
  });
});

describe('focus scoping: arrows must not hijack page scroll', () => {
  it('acts on arrow keys only while focus is inside the player', () => {
    expect(resolvePlayerCommand(key('ArrowUp'), true)).toBe('volume-up');
    expect(resolvePlayerCommand(key('ArrowDown'), true)).toBe('volume-down');
  });

  it('does NOT consume an arrow key when focus is outside the player', () => {
    // The component only calls preventDefault when this returns a command, so
    // undefined here means the browser keeps its default scroll behaviour.
    expect(resolvePlayerCommand(key('ArrowUp'), false)).toBeUndefined();
    expect(resolvePlayerCommand(key('ArrowDown'), false)).toBeUndefined();
    expect(shouldHandleCommand('volume-up', false)).toBe(false);
    expect(shouldHandleCommand('volume-down', false)).toBe(false);
  });

  it('keeps the letter shortcuts page-level, from inside or outside the player', () => {
    for (const inside of [true, false]) {
      expect(resolvePlayerCommand(key('k'), inside)).toBe('toggle-play');
      expect(resolvePlayerCommand(key('m'), inside)).toBe('toggle-mute');
      expect(resolvePlayerCommand(key('f'), inside)).toBe('toggle-fullscreen');
      expect(resolvePlayerCommand(key('l'), inside)).toBe('seek-live');
    }
  });

  it('still ignores letters typed into a field even when the player has focus', () => {
    expect(resolvePlayerCommand(key('m', { target: element('INPUT', { type: 'search' }) }), true)).toBeUndefined();
  });
});

describe('clampVolume', () => {
  it('clamps into 0..1 and rounds float noise', () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(0.8 + VOLUME_STEP)).toBe(0.85);
    expect(clampVolume(0.1 + 0.2)).toBe(0.3);
  });

  it('falls back to 0 for a non-finite value instead of propagating NaN', () => {
    expect(clampVolume(Number.NaN)).toBe(0);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
