import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent, type IconName } from './icon.component';

/**
 * Shared "nothing here yet" surface: always states what the user can do next.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="empty" [class.empty--compact]="compact()">
      <span class="empty__icon" aria-hidden="true">
        <app-icon [name]="icon()" [size]="compact() ? 20 : 26" />
      </span>
      <div class="empty__body">
        <p class="empty__title">{{ title() }}</p>
        @if (message()) {
          <p class="empty__message">{{ message() }}</p>
        }
        <ng-content />
      </div>
    </div>
  `,
  styles: `
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-8) var(--s-5);
      text-align: center;
      border: 1px dashed var(--border-strong);
      border-radius: var(--r-lg);
      background: color-mix(in srgb, var(--surface-1) 70%, transparent);
    }

    .empty--compact {
      flex-direction: row;
      align-items: flex-start;
      text-align: left;
      padding: var(--s-4);
      gap: var(--s-3);
    }

    .empty__icon {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--surface-3);
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .empty__title {
      font-weight: 650;
      color: var(--text);
    }

    .empty__message {
      margin-top: var(--s-1);
      color: var(--text-muted);
      font-size: var(--fs-sm);
      max-width: 46ch;
    }
  `,
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly message = input<string>('');
  readonly icon = input<IconName>('info');
  readonly compact = input(false);
}
