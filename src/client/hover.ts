/**
 * The balance popover's hover state machine, kept free of the DOM so it can be
 * driven directly by tests.
 *
 * Earlier versions trusted one signal at a time: React's `onMouseLeave`, then a
 * document `pointermove` watcher, then polling the wrapper's CSS `:hover`. Each
 * time the one signal went missing or went stale, the panel either stuck open
 * or flapped shut and open again. Two rules fix that:
 *
 * - **Opening needs positive evidence.** The pointer has to *move* into the
 *   chip's rect and then stay there for a short dwell. A chip that mounts or
 *   flies under a resting pointer gets no movement, so it never opens by
 *   itself.
 * - **Closing needs only one witness.** The last known pointer position falls
 *   outside the rect, `:hover` reads false twice in a row, the pointer leaves
 *   the window, or the panel has been open too long: any one of these closes
 *   it. Every close clears the armed dwell, so the panel stays shut until the
 *   pointer moves back in. A wobbling signal can close the panel but can
 *   never reopen it, which is where the flicker came from.
 *
 * When no pointer events ever arrive (a shell that swallows them), the
 * machine falls back to `:hover` false→true transitions to open.
 */

/** A viewport rectangle (a `DOMRect` fits). */
export interface HoverRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Tunables, in milliseconds and CSS pixels. */
export interface HoverOptions {
  /** How long the pointer must rest inside before the panel opens. */
  readonly dwellMs: number
  /** How long after a close before the panel may open again. */
  readonly cooldownMs: number
  /** An open panel closes by itself after this long. */
  readonly maxOpenMs: number
  /** Tolerance around the chip's rect, so a sub-pixel edge does not count as leaving. */
  readonly slop: number
  /** Consecutive `:hover === false` ticks that close an open panel. */
  readonly missTicks: number
}

export const HOVER_DEFAULTS: HoverOptions = {
  dwellMs: 120,
  cooldownMs: 250,
  maxOpenMs: 15_000,
  slop: 2,
  missTicks: 2,
}

/** The popover hover state machine. All times come from the caller's clock. */
export interface HoverMachine {
  /**
   * A pointer position from any event.
   * @param moved - true only for a genuine movement (not a layout-induced
   * `mouseover` or a zero-delta synthetic move); only movement can arm opening.
   */
  pointer(x: number, y: number, now: number, moved: boolean): void
  /** The pointer left the window, or the window lost focus or visibility. */
  pointerGone(now: number): void
  /**
   * The periodic check.
   * @param hovered - the chip's `:hover` state, or undefined when no chip is mounted.
   */
  tick(now: number, hovered: boolean | undefined): void
  /** The chip element was replaced (a seat swap or session switch): forget everything. */
  reset(now: number, hovered: boolean | undefined): void
  /** An outside dismissal (Escape, an outside press, a seat swap). */
  dismiss(now: number): void
  readonly open: boolean
}

/**
 * Build a hover machine.
 * @param getRect - the chip's current viewport rect, or null when it is not mounted.
 * @param onOpen - shows the panel.
 * @param onClose - hides the panel.
 * @param initialHovered - the chip's `:hover` at creation; a chip hovered from
 * the start must never count that as an enter.
 */
export function createHoverMachine(
  getRect: () => HoverRect | null,
  onOpen: () => void,
  onClose: () => void,
  initialHovered: boolean | undefined,
  options: Partial<HoverOptions> = {},
): HoverMachine {
  const opts: HoverOptions = { ...HOVER_DEFAULTS, ...options }
  let open = false
  let openedAt = 0
  let closedAt = Number.NEGATIVE_INFINITY
  /** When a genuine enter armed the dwell; null when not armed. */
  let armedAt: number | null = null
  let x = Number.NaN
  let y = Number.NaN
  let sawEvents = false
  let wasHovered = initialHovered === true
  let misses = 0

  const inside = (px: number, py: number): boolean => {
    const r = getRect()
    if (r === null || Number.isNaN(px) || Number.isNaN(py)) return false
    return px >= r.left - opts.slop && px <= r.right + opts.slop
      && py >= r.top - opts.slop && py <= r.bottom + opts.slop
  }

  const close = (now: number): void => {
    armedAt = null
    misses = 0
    if (!open) return
    open = false
    closedAt = now
    onClose()
  }

  return {
    get open() { return open },

    pointer(px, py, now, moved) {
      sawEvents = true
      x = px
      y = py
      if (!inside(px, py)) {
        close(now)
        return
      }
      if (moved && armedAt === null && !open) armedAt = now
    },

    pointerGone(now) {
      x = Number.NaN
      y = Number.NaN
      close(now)
    },

    tick(now, hovered) {
      if (hovered === undefined) {
        close(now)
        wasHovered = false
        return
      }
      if (open) {
        // The chip can move out from under a resting pointer (a re-render, the
        // FLIP flight); re-test the last known position against the new rect.
        if (sawEvents && !inside(x, y)) { close(now); wasHovered = hovered; return }
        misses = hovered ? 0 : misses + 1
        if (misses >= opts.missTicks) { close(now); wasHovered = hovered; return }
        if (now - openedAt >= opts.maxOpenMs) {
          // Ending a long peek: stay shut until the pointer moves back in.
          close(now)
          wasHovered = hovered
          return
        }
        wasHovered = hovered
        return
      }
      if (!hovered) {
        armedAt = null
      } else if (!sawEvents && !wasHovered && armedAt === null) {
        // Fallback for a shell that delivers no pointer events at all.
        armedAt = now
      }
      wasHovered = hovered
      if (armedAt === null) return
      if (now - armedAt < opts.dwellMs) return
      if (now - closedAt < opts.cooldownMs) return
      if (sawEvents && !inside(x, y)) { armedAt = null; return }
      open = true
      openedAt = now
      misses = 0
      armedAt = null
      onOpen()
    },

    reset(now, hovered) {
      close(now)
      wasHovered = hovered === true
    },

    dismiss(now) {
      close(now)
    },
  }
}
