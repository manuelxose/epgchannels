/**
 * Keyboard shortcuts for the live player.
 *
 * The mapping lives here, as a pure function, so it can be tested without a DOM
 * and so the component never grows a second copy of the rules.
 *
 * Design rules:
 * - Single keys only for the player's own surface. Every shortcut is ALSO a
 *   real, focusable control in the controls bar, so keyboard access never
 *   depends on knowing a shortcut (WCAG 2.2: keyboard accessible).
 * - Shortcuts are ignored while the user is typing in a field, so search and
 *   select controls keep working unchanged.
 * - `Escape` is handled by the browser for fullscreen; we do not intercept it.
 */

/** What a key press asks the player to do. */
export type PlayerCommand =
  | 'toggle-play'
  | 'toggle-mute'
  | 'toggle-fullscreen'
  | 'volume-up'
  | 'volume-down'
  | 'seek-live';

/** Elements that keep their own key handling. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'tel',
  'url',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/**
 * Input types whose key handling belongs to the control, not to the player.
 * `range` is here because the volume slider must keep its own arrow keys.
 */
const SELF_HANDLING_INPUT_TYPES = new Set([...TEXT_INPUT_TYPES, 'range', 'checkbox', 'radio', 'color', 'file']);

/**
 * ARIA roles that manage their own keyboard interaction (menus, listboxes,
 * tabs, trees, dialogs). A shortcut must never fire while one of these holds
 * focus, or the player would steal `m`/`k`/`f` from the component being used.
 */
const SELF_HANDLING_ROLES = new Set([
  'listbox',
  'option',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'tab',
  'tablist',
  'tree',
  'treeitem',
  'grid',
  'gridcell',
  'dialog',
  'alertdialog',
  'slider',
  'spinbutton',
  'textbox',
]);

/** True when the event target is a control that must receive the key itself. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') {
    return false;
  }
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea') {
    return true;
  }
  if (tag === 'input') {
    const type = (element as HTMLInputElement).type;
    return SELF_HANDLING_INPUT_TYPES.has(type) || type === '';
  }
  if (tag === 'select') {
    return true;
  }
  // Content-editable surfaces are text entry too.
  if (element.isContentEditable === true) {
    return true;
  }
  // One of our own composite widgets (search suggestions, menus, dialogs).
  const role = element.getAttribute?.('role');
  return typeof role === 'string' && SELF_HANDLING_ROLES.has(role.toLowerCase());
}

/**
 * Maps a keyboard event to a player command, or `undefined` when the key is not
 * one of ours (so the browser keeps its default behaviour).
 *
 * Modifier combinations are left to the browser and to the user's assistive
 * technology: a command requires no Ctrl/Alt/Meta.
 */
export function commandFor(event: KeyboardEvent): PlayerCommand | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return undefined;
  }
  if (isTypingTarget(event.target)) {
    return undefined;
  }
  switch (event.key) {
    case ' ':
    case 'Spacebar':
      // A focused button already turns Space into a click; letting the player
      // also toggle would double-handle it.
      return isButtonTarget(event.target) ? undefined : 'toggle-play';
    case 'k':
    case 'K':
      return 'toggle-play';
    case 'm':
    case 'M':
      return 'toggle-mute';
    case 'f':
    case 'F':
      return 'toggle-fullscreen';
    case 'l':
    case 'L':
      return 'seek-live';
    case 'ArrowUp':
      return 'volume-up';
    case 'ArrowDown':
      return 'volume-down';
    default:
      return undefined;
  }
}

/** True when the target is a button or link that owns Space/Enter itself. */
function isButtonTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') {
    return false;
  }
  const tag = (target as HTMLElement).tagName.toLowerCase();
  return tag === 'button' || tag === 'a' || tag === 'summary';
}

/** Volume step applied by the arrow keys/keyboard, as a 0..1 fraction. */
export const VOLUME_STEP = 0.05;

/** Clamps a volume to the 0..1 range, rounding float noise away. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }
  return Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
}

/** Non-letter shortcuts: they act on the volume and would fight page scrolling. */
const VOLUME_COMMANDS: ReadonlySet<PlayerCommand> = new Set<PlayerCommand>(['volume-up', 'volume-down']);

/**
 * Decides whether a shortcut may run, given where focus currently is.
 *
 * **Arrow keys are scoped to the player surface.** They are the browser's own
 * scroll keys, so consuming them anywhere else on the page would break
 * keyboard scrolling for every user (a WCAG 2.2 problem). Volume therefore
 * only responds to arrows while focus is inside the player region.
 *
 * The letter shortcuts (K/M/F/L) are page-level: they are unambiguous on a
 * watch page and never collide with scrolling, so they work from anywhere that
 * is not a text field or one of our composite widgets.
 *
 * The component calls this before handling, and only calls `preventDefault`
 * when it returns true — so an ignored key keeps its default behaviour.
 */
export function shouldHandleCommand(command: PlayerCommand, playerHasFocus: boolean): boolean {
  if (VOLUME_COMMANDS.has(command)) {
    return playerHasFocus;
  }
  return true;
}

/**
 * Full decision for one key event: `undefined` means "not ours, leave the
 * default alone". Combines the mapping with the focus scoping above.
 */
export function resolvePlayerCommand(event: KeyboardEvent, playerHasFocus: boolean): PlayerCommand | undefined {
  const command = commandFor(event);
  if (!command) {
    return undefined;
  }
  return shouldHandleCommand(command, playerHasFocus) ? command : undefined;
}
