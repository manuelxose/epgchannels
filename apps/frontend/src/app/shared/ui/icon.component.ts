import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'search'
  | 'heart'
  | 'heart-filled'
  | 'play'
  | 'pause'
  | 'volume'
  | 'volume-muted'
  | 'fullscreen'
  | 'fullscreen-exit'
  | 'pip'
  | 'live'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'grid'
  | 'tv'
  | 'info'
  | 'external'
  | 'alert'
  | 'sun'
  | 'moon'
  | 'close'
  | 'clock'
  | 'settings'
  | 'menu'
  | 'cast'
  | 'signal-off';

const PATHS: Readonly<Record<IconName, string>> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2',
  heart: 'M12 20s-7-4.35-7-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7 3.5C19 15.65 12 20 12 20Z',
  'heart-filled': 'M12 20s-7-4.35-7-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7 3.5C19 15.65 12 20 12 20Z',
  play: 'M8 5.5v13l11-6.5-11-6.5Z',
  pause: 'M9 5v14M15 5v14',
  volume: 'M4 9.5h3l4-3.5v12l-4-3.5H4v-5ZM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
  'volume-muted': 'M4 9.5h3l4-3.5v12l-4-3.5H4v-5ZM16 9l5 6M21 9l-5 6',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  'fullscreen-exit': 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  pip: 'M4 5h16v14H4zM12 11h6v6h-6z',
  live: 'M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0ZM4.9 7a10 10 0 0 0 0 10M19.1 7a10 10 0 0 1 0 10',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  tv: 'M3 7h18v12H3zM8 3l4 4 4-4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7.5v.5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  alert: 'M12 4 2.5 20h19L12 4ZM12 10v4.5M12 17.5v.5',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  close: 'M6 6l12 12M18 6 6 18',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4.2l3 1.8',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.6A7.7 7.7 0 0 0 6.9 6.6l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.7 7.7 0 0 0 2.6 1.5l.5 2.6h4l.5-2.6a7.7 7.7 0 0 0 2.6-1.5l2.3 1 2-3.4-2-1.5Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  // Screen with a broadcast corner: the conventional "send to a device" glyph.
  cast: 'M3 4h18v16H3zM7 20a4 4 0 0 0-4-4M7 20a4 4 0 0 1 4 4',
  'signal-off': 'M3 3l18 18M7 14a7 7 0 0 1 4-2M5 10a11 11 0 0 1 4-2.6M17 14a7 7 0 0 0-2-1.4M19 10a11 11 0 0 0-4-2.6M12 18v.5',
};

const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play', 'heart-filled']);

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      [attr.fill]="filled ? 'currentColor' : 'none'"
      stroke="currentColor"
      [attr.stroke-width]="filled ? 0 : 1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path [attr.d]="path" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly size = input(20);

  get path(): string {
    return PATHS[this.name()];
  }

  get filled(): boolean {
    return FILLED.has(this.name());
  }
}
