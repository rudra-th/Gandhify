/**
 * Deterministic film-playback clock for the morph replay.
 *
 * The replay is intentionally NOT a loop: it holds on the very first film
 * frame (the original photo) for `holdMs`, then advances one frame per
 * `frameMs` interval with small chronological batches of pixel swaps, and
 * finally STOPS once the film's last frame (the finished Gandhi) is reached.
 * Reversing mirrors that: hold on the last frame, walk backward, stop on the
 * source photo.
 *
 * Pure and dependency-free so the stop-at-the-end behaviour is unit-testable
 * in Node, while the browser owns only the setInterval that calls `tick()`.
 */

export interface FilmStep {
  /** index of the film frame that should be drawn now */
  frame: number
  /** false the instant the film reaches an edge — playback has stopped */
  running: boolean
}

export interface FilmClockOptions {
  frameCount: number
  holdMs: number
  frameMs: number
}

export function makeFilmClock(cfg: FilmClockOptions) {
  const frameCount = Math.max(1, Math.floor(cfg.frameCount))
  const holdTicks = Math.max(1, Math.round(cfg.holdMs / cfg.frameMs))

  let index = 0
  let hold = 0
  let running = false
  let reverse = false

  return {
    get index() {
      return index
    },
    get running() {
      return running
    },
    get reverse() {
      return reverse
    },
    get hold() {
      return hold
    },

    setReverse(v: boolean) {
      reverse = v
    },

    /** restart the film from the edge that matches the current direction. */
    begin(): FilmStep {
      index = reverse ? frameCount - 1 : 0
      hold = holdTicks
      running = true
      return { frame: index, running: true }
    },

    pause() {
      running = false
    },

    /** advance one frame interval; clamps and stops (no wrapping) at the edges. */
    tick(): FilmStep {
      if (!running) return { frame: index, running: false }
      if (hold > 0) {
        hold -= 1
        return { frame: index, running: true }
      }
      index += reverse ? -1 : 1
      if (index < 0 || index >= frameCount) {
        index = Math.max(0, Math.min(frameCount - 1, index))
        running = false
      }
      return { frame: index, running }
    },
  }
}

export type FilmClock = ReturnType<typeof makeFilmClock>