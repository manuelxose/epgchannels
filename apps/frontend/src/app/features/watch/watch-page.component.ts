import {
  afterNextRender,
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  runInInjectionContext,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { ChannelHeaderComponent } from './channel-header.component';
import { PlayerComponent } from './player/player.component';
import { ProgrammePanelComponent } from './programme-panel.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { IconComponent } from '../../shared/ui/icon.component';
import { CatalogStore } from '../../core/state/catalog.store';
import { EpgApiService } from '../../core/api/epg-api.service';
import { PreferencesStore } from '../../core/state/preferences.store';
import { PlayerController } from '../../core/state/player.controller';
import { resolveNowNext } from '../../core/epg/now-next';
import { isEligibleSource } from '../../core/models/catalog.model';
import { verifiedPlaybackState, type VerifiedState } from '../../core/integrations/verified-state';
import { probePlaybackCapabilities } from '../../core/integrations/capabilities';
import { deepActiveElement, focusFirst, inertBackground, lockScroll, trapTabKey } from '../../core/a11y/focus-trap';
import type { Channel, EpgProgram } from '../../core/models/catalog.model';

/**
 * Channel watch page: the verified state, the right player for it, the channel
 * identity and the programme guide.
 *
 * Nothing here guesses: the state comes from `verifiedPlaybackState`, which only
 * accepts facts the published catalog carries (see `docs/INTEGRATIONS.md`).
 */
@Component({
  selector: 'app-watch-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ChannelHeaderComponent,
    PlayerComponent,
    ProgrammePanelComponent,
    EmptyStateComponent,
    IconComponent,
  ],
  templateUrl: './watch-page.component.html',
  styleUrl: './watch-page.component.css',
})
export class WatchPageComponent implements OnDestroy {
  readonly channelId = input<string | undefined>(undefined);

  protected readonly catalog = inject(CatalogStore);
  protected readonly epgApi = inject(EpgApiService);
  protected readonly preferences = inject(PreferencesStore);
  protected readonly controller = inject(PlayerController);
  private readonly title = inject(Title);
  /** Provides the injector needed to arm `afterNextRender` from a DOM event. */
  private readonly applicationRef = inject(ApplicationRef);
  /** The component element; the drawer is rendered in its shadow root. */
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly locale = 'es-ES';
  protected readonly now = signal(new Date());
  protected readonly sourceIndex = signal(0);
  protected readonly scheduleOpen = signal(false);
  /** Set once the user declined the embed and asked for the official page. */
  protected readonly embedDismissed = signal(false);
  protected readonly embedBlockedReason = signal<string | undefined>(undefined);

  private readonly drawerRef = viewChild<ElementRef<HTMLElement>>('drawer');
  private clock: ReturnType<typeof setInterval> | undefined;
  private releaseDrawer: (() => void) | undefined;
  private drawerWasOpen = false;
  /** The control that opened the drawer; focus returns here on close. */
  private opener: HTMLElement | undefined;

  protected readonly capabilities = probePlaybackCapabilities();
  protected readonly channel = computed<Channel | undefined>(() => this.catalog.channelById(this.channelId()));
  protected readonly loadingCatalogue = computed(() => this.catalog.status() === 'loading');
  /** Options the header offers: only the ones the in-app player can attempt. */
  protected readonly sources = computed(() => this.channel()?.sources.filter(isEligibleSource) ?? []);
  protected readonly selectedSource = computed(() => this.sources()[this.sourceIndex()]);
  protected readonly schedule = computed(() => this.catalog.scheduleFor(this.channel()));
  protected readonly nowNext = computed(() => resolveNowNext(this.schedule(), this.now()));
  protected readonly favourite = computed(() => {
    const channel = this.channel();
    return channel ? this.preferences.favorites().has(channel.id) : false;
  });
  protected readonly upcomingPrograms = computed(() => {
    const programs = this.schedule()?.programs ?? [];
    const from = this.now().getTime();
    return programs.filter((program) => program.end.getTime() > from).slice(0, 14);
  });

  /** The full published day, used by the schedule drawer. */
  protected readonly dayPrograms = computed(() => this.schedule()?.programs ?? []);

  protected readonly verified = computed<VerifiedState | undefined>(() => {
    const channel = this.channel();
    if (!channel) {
      return undefined;
    }
    /*
     * Every published option, plus the capabilities. This was filtered to the
     * "eligible" sources while fixing the REF/UAG leak, but that also dropped
     * YouTube pages — which are never engine-eligible yet are exactly what the
     * official IFrame player must show — so every embed channel fell back to a
     * plain link. The leak is fixed where it belongs: the model decides that a
     * channel with an access restriction (`requiresOfficialAccess`) is never
     * `live`, whatever its URLs look like.
     */
    return verifiedPlaybackState({ channel, sources: channel.sources, capabilities: this.capabilities });
  });

  /** The official YouTube page to show in the IFrame player, when verified. */
  protected readonly embedSource = computed(() => {
    const action = this.verified()?.action;
    if (action?.kind !== 'embed') {
      return undefined;
    }
    return this.channel()?.sources.find((source) => source.id === action.sourceId);
  });

  /**
   * True when this source is played **inside our player** by the official
   * YouTube engine: a `/live/<id>` video, or a channel page whose live video is
   * resolved at runtime. Such a source is no longer a link-out.
   */
  protected readonly playsYoutubeInApp = computed(() => {
    const source = this.embedSource();
    return Boolean(source && source.format === 'youtube');
  });

  /** Show YouTube's own player when the verified state permits embedding. */
  protected readonly showEmbed = computed(
    () => this.verified()?.kind === 'official-embed' && !this.embedDismissed() && !this.playsYoutubeInApp(),
  );

  protected readonly officialLink = computed(() => {
    const action = this.verified()?.action;
    return action?.kind === 'external' ? action.url : undefined;
  });

  constructor() {
    /*
     * Track a changing channel: pull its full record (sources + playback
     * descriptor) from our API and load its guide. The list endpoint returns a
     * trimmed record, so this is the step that makes a channel playable.
     */
    effect(() => {
      const slug = this.channelId();
      if (slug) {
        void this.loadChannelDetail(slug);
      }
    });

    // Reset source picker, remember the channel and update the title.
    effect(() => {
      const channel = this.channel();
      if (!channel) {
        return;
      }
      const playable = channel.sources.filter(isEligibleSource);
      const preferred = this.preferences.preferredSourceIndex(channel.id);
      this.sourceIndex.set(Math.min(preferred, Math.max(0, playable.length - 1)));
      this.preferences.rememberChannel(channel.id);
      this.title.setTitle(`${channel.name} en directo · TDT Player`);
    });

    // Reset the embed decision when the channel changes.
    effect(() => {
      this.channelId();
      untracked(() => {
        this.embedDismissed.set(false);
        this.embedBlockedReason.set(undefined);
      });
    });

    // Drawer: inert background + scroll lock + focus in, and focus restore out.
    effect(() => {
      const open = this.scheduleOpen();
      if (open === this.drawerWasOpen) {
        return;
      }
      this.drawerWasOpen = open;
      untracked(() => {
        if (!open) {
          this.releaseDrawer?.();
        }
      });
    });

    // Keep the guide window accurate without re-rendering on every video frame.
    // `force: false`: the clock only refreshes what `epgRefreshMs` has aged out,
    // instead of asking the API for the same guide every 30 s.
    this.clock = setInterval(() => {
      this.now.set(new Date());
      const slug = this.channelId();
      if (slug) {
        void this.catalog.ensureEpg([slug]);
      }
    }, 30_000);
  }

  /** Loads the channel record and descriptor from our API, then its guide. */
  private async loadChannelDetail(slug: string): Promise<void> {
    await this.catalog.ensureChannelDetail(slug);
    // Not forced: the record effect above already asked for this guide, and
    // `ensureEpg` joins the request in flight rather than issuing a second one.
    await this.catalog.ensureEpg([slug]);
  }

  ngOnDestroy(): void {
    if (this.clock !== undefined) {
      clearInterval(this.clock);
    }
    this.releaseDrawer?.();
    this.releaseDrawer = undefined;
    this.controller.clear();
  }

  protected onSourceChange(index: number): void {
    const channel = this.channel();
    if (!channel) {
      return;
    }
    this.sourceIndex.set(index);
    this.preferences.setPreferredSourceIndex(channel.id, index);
  }

  protected onFavourite(channelId: string): void {
    this.preferences.toggleFavorite(channelId);
  }

  protected openSchedule(): void {
    // Remember the real opener (deep: it can live outside any shadow root) so the
    // contract can put focus back there when the drawer closes.
    this.opener = deepActiveElement() ?? this.hostRef.nativeElement;
    this.scheduleOpen.set(true);
    // `afterNextRender` needs an injection context. The component is standalone
    // and uses the browser renderer, so its own environment injector is the
    // application injector held by `ApplicationRef`.
    const injector = this.applicationRef.injector;
    runInInjectionContext(injector, () => afterNextRender(() => this.applyDrawerContract()));
  }

  protected closeSchedule(): void {
    this.scheduleOpen.set(false);
  }

  /** The drawer's keydown handler: Escape closes, Tab stays inside. */
  protected onDrawerKeydown(event: KeyboardEvent): void {
    const drawer = this.drawerRef()?.nativeElement;
    if (!drawer) {
      return;
    }
    const options = {
      host: this.hostRef.nativeElement,
      focusRoot: drawer.querySelector<HTMLElement>('.drawer__body') ?? undefined,
    };
    if (trapTabKey(event, drawer, options) === 'close') {
      this.closeSchedule();
    }
  }

  /** The official embed refused the stream (owner disabled it): fall back to a link. */
  protected onEmbedBlocked(reason: string): void {
    this.embedBlockedReason.set(reason);
    this.embedDismissed.set(true);
  }

  /** User asked for the emitter's page instead of the embed. */
  protected useOfficialPage(): void {
    this.embedDismissed.set(true);
  }

  protected isNow(program: EpgProgram): boolean {
    const time = this.now().getTime();
    return program.start.getTime() <= time && time < program.end.getTime();
  }

  protected timeLabel(program: EpgProgram): string {
    const format = new Intl.DateTimeFormat(this.locale, { hour: '2-digit', minute: '2-digit' });
    return `${format.format(program.start)} – ${format.format(program.end)}`;
  }

  protected blockedReasonLabel(reason: string): string {
    switch (reason) {
      case 'geo':
        return 'Bloqueo regional';
      case 'unplayable-url':
        return 'Requiere datos de cliente';
      case 'format':
        return 'Formato no admitido';
      default:
        return 'No reproducible aquí';
    }
  }

  /**
   * Applies the modal contract to the rendered dialog. Angular renders the
   * drawer after the state flip, so this runs from an `afterNextRender` hook:
   * the background becomes inert, the page cannot scroll, and focus moves into
   * the dialog. The returned release function undoes all three.
   *
   * Exposed as a field (not a method) so it is callable from the template
   * context; only the effect below uses it.
   */
  private readonly applyDrawerContract = (): void => {
    const drawer = this.drawerRef()?.nativeElement;
    if (!drawer) {
      return;
    }
    // The drawer lives in the host's shadow root: everything that is NOT on its
    // path becomes inert; the page cannot scroll; focus moves into the dialog
    // and, on close, returns to the control that opened it.
    const releaseInert = inertBackground(drawer, this.hostRef.nativeElement);
    const releaseScroll = lockScroll();
    const opener = this.opener;
    focusFirst(drawer);
    this.releaseDrawer = () => {
      releaseScroll();
      releaseInert();
      if (opener?.isConnected) {
        opener.focus();
      }
      this.releaseDrawer = undefined;
    };
  };
}
