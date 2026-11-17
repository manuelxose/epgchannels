# Design System — TDT Player Rebuild

> Adapted from `design-system/tdt-player-rebuild/MASTER.md`. The generated palette
> (sage neutral + teal) was **overridden**: it does not fit a broadcast TV guide.
> The implemented direction below is the source of truth.

## 1. Product positioning

A live-television guide and player for a large, categorised channel catalogue.
The product moment is "I know the channel I want, or I want to browse" — so the
interface is a **dense, scannable catalogue beside a cinematic player stage**.

We intentionally ship a **dark-first** interface. Live TV is consumed in low
light; a dark stage makes the video the brightest element on screen. A light
theme is supported and persisted.

## 2. Visual direction — "Midnight Broadcast"

- **Base**: OLED-adjacent midnight (`#0A0E17`) rather than pure black, so elevation
  can be expressed with surfaces rather than shadows.
- **Identity accent**: broadcast amber (`#FBBF24`) — the colour of an on-air lamp.
  Used *only* for live/on-air state and the primary action. Never as decoration.
- **Signal violet** (`#7C5CFF`) for interactive selection and focus ring.
- **Typography**: system UI stack for body (zero network cost, native legibility,
  no FOUT), with tabular numerals for timecodes and EPG clocks.
- **Density**: standard-dense catalogue (compact tiles), spacious player stage.
- **Motion**: 150–250 ms, meaningful only (state transitions, panel reveal).
  Everything collapses under `prefers-reduced-motion: reduce`.
- **Elevation**: 3 surface steps + 1 border alpha ramp. No drop shadows except
  the player overlay (needs separation from video).

Anti-patterns rejected: rose/vibrant marketing palettes, gradient text,
glassmorphism everywhere, emoji icons, hero-marketing sections.

## 3. Design tokens

Implemented in `src/styles/tokens.css`. Both themes share the same token names.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#0A0E17` | `#F4F6FA` | App background |
| `--surface-1` | `#111726` | `#FFFFFF` | Panels, cards |
| `--surface-2` | `#161E30` | `#EEF1F7` | Inputs, tiles |
| `--surface-3` | `#1E2840` | `#E3E8F1` | Hover / elevated |
| `--border` | `#243049` | `#D6DCE8` | Dividers |
| `--border-strong` | `#33415F` | `#B9C3D6` | Focusable outlines |
| `--text` | `#F2F5FA` | `#0B1020` | Primary text |
| `--text-muted` | `#9AA7BE` | `#4A5568` | Secondary text |
| `--accent` | `#FBBF24` | `#B45309` | Live / primary action |
| `--on-accent` | `#1A1200` | `#FFFFFF` | Text on accent |
| `--signal` | `#7C5CFF` | `#5B3FE0` | Selection, ring |
| `--ok` | `#34D399` | `#047857` | Playing |
| `--warn` | `#FBBF24` | `#B45309` | Buffering |
| `--danger` | `#F87171` | `#B91C1C` | Errors |

**Contrast**: every text/background pair used in the app meets **≥ 4.5:1**
(normal text). `--text-muted` on `--surface-1` = 6.9:1 (dark) / 7.4:1 (light).
Accent is only used behind `--on-accent` (13.5:1) or as a 2px+ non-text
indicator (SC 1.4.11 ≥ 3:1).

## 4. Spacing, radius, type scale

- Space scale: `4 8 12 16 20 24 32 40 56` px (`--s-1 … --s-9`).
- Radius: `6px` controls, `12px` panels, `999px` pills.
- Type scale (rem): `0.75 / 0.8125 / 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.25`.
- Body 15px minimum; never below 12px for labels.

## 5. Layout

| Breakpoint | Layout |
| --- | --- |
| `< 720px` (mobile) | Single column. **Player first**, then catalogue. Sticky compact header. Channel list becomes a bottom-sheet picker opened from the player. |
| `720–1023px` (tablet) | Player on top, catalogue below in a wider grid (4 cols). |
| `≥ 1024px` (desktop) | Three columns: catalogue rail `clamp(280px, 24vw, 360px)` · player stage (flex) · info rail `clamp(240px, 20vw, 320px)` |
| `≥ 1600px` | Catalogue rail grows to 400px; stage max-width capped for comfortable video. |

The player stage is `position: sticky` on desktop so the video stays visible while
the EPG below scrolls.

## 6. Components

- **AppShell**: header (brand, nav, theme toggle) + routed content.
- **CatalogueRail**: search input, category select, favourites toggle, result
  counter (live region), tile grid, pagination.
- **ChannelTile**: 64px logo well + name; selected state = 2px signal ring +
  surface-3 background + `aria-current`.
- **PlayerStage**: 16:9 video region, control bar, overlays (now-playing,
  buffering, error, blocked), source picker.
- **ChannelHeader**: logo, name, category, official-site link, favourite button,
  source selector.
- **NowNextPanel**: "Ahora" card with cover, genre chip, time range, description;
  next/after rows; "Ver parrilla" action.
- **ScheduleDrawer**: scrollable 24h timeline per channel.

## 7. Interaction & feedback rules

- Every actionable element has ≥ 44px touch target on mobile.
- Focus: 2px `--signal` ring + 2px offset, never removed; `:focus-visible` only.
- Loading: skeletons for catalogue, spinner overlay on player.
- Empty states always explain the **next action**.
- Status changes (buffering, error, source switch, favourite toggle) surface via
  `role="status"` live regions.
- Under reduced motion: no tile stagger, no overlay slide; instant state swaps.

## 8. Iconography

Inline SVG only, 1.75px stroke, 24×24 viewBox, `currentColor`. Icons that appear
alone carry `aria-label`; decorative icons are `aria-hidden="true"`. No emoji.
