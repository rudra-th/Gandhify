import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFilmClock } from '../src/filmplayback.ts'

const holdMs = 2000
const frameMs = 42

function runUntilStop(clock: ReturnType<typeof makeFilmClock>, maxTicks: number) {
  const frames: number[] = []
  for (let i = 0; i < maxTicks; i++) {
    const step = clock.tick()
    frames.push(step.frame)
    if (!step.running) return { frames, stoppedAt: i + 1 }
  }
  throw new Error('film never stopped within the tick budget')
}

test('holds on the first frame for holdMs, then advances', () => {
  const clock = makeFilmClock({ frameCount: 100, holdMs, frameMs })
  const step = clock.begin()
  assert.equal(step.frame, 0)
  assert.equal(step.running, true)

  const ticksPerHold = Math.round(holdMs / frameMs)
  for (let i = 0; i < ticksPerHold; i++) {
    assert.equal(clock.tick().frame, 0, `tick ${i} should still show frame 0`)
  }
  assert.equal(clock.tick().frame, 1, 'first advance after the hold')
})

test('stops on the last frame without wrapping', () => {
  const clock = makeFilmClock({ frameCount: 5, holdMs: 100, frameMs: 50 })
  clock.begin()
  const { frames, stoppedAt } = runUntilStop(clock, 1000)
  assert.equal(frames[frames.length - 1], 4, 'ends holding the final frame')
  assert.ok(stoppedAt <= 1000)
  // the film never re-showed frame 0 after leaving it
  const afterLeave = frames.slice(Math.round(100 / 50))
  assert.ok(!afterLeave.includes(0), 'no wrap back to frame 0')
})

test('reverse holds on the last frame and stops on frame 0', () => {
  const clock = makeFilmClock({ frameCount: 5, holdMs: 100, frameMs: 50 })
  clock.setReverse(true)
  const step = clock.begin()
  assert.equal(step.frame, 4)
  for (let i = 0; i < Math.round(100 / 50); i++) assert.equal(clock.tick().frame, 4)
  assert.equal(clock.tick().frame, 3)
  const { frames } = runUntilStop(clock, 1000)
  assert.equal(frames[frames.length - 1], 0, 'reverse stops on the source frame')
})

test('single-frame film never advances and halts cleanly', () => {
  const clock = makeFilmClock({ frameCount: 1, holdMs: 100, frameMs: 50 })
  clock.begin()
  for (let i = 0; i < Math.round(100 / 50); i++) assert.equal(clock.tick().frame, 0)
  const step = clock.tick()
  assert.equal(step.frame, 0)
  assert.equal(step.running, false)
})

test('begin() restarts from the matching edge with a fresh hold', () => {
  const clock = makeFilmClock({ frameCount: 10, holdMs: 100, frameMs: 50 })
  clock.begin()
  for (let i = 0; i < 5; i++) clock.tick()
  const step = clock.begin()
  assert.equal(step.frame, 0)
  assert.equal(clock.hold, Math.round(100 / 50))
})

test('pause freezes position and keeps tick() inert', () => {
  const clock = makeFilmClock({ frameCount: 10, holdMs: 84, frameMs: 42 })
  clock.begin()
  clock.tick()
  clock.tick()
  clock.pause()
  const frozen = clock.index
  assert.equal(clock.tick().running, false, 'tick while paused is inert')
  clock.tick()
  assert.equal(clock.index, frozen)
})