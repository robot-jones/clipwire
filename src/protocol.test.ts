import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatProgress,
  parseFrame,
  renderProgress,
  FULL_BLOCK,
  LIGHT_SHADE,
  type EndFrame,
  type MetaFrame,
} from './protocol.js';
import { silenceProgress } from './test-helpers.js';

function barOf(line: string): string {
  const match = /\[([█░]*)\]/.exec(line);
  assert.ok(match?.[1] !== undefined, `no bar found in: ${JSON.stringify(line)}`);
  return match[1];
}

test('parseFrame round-trips a META frame', () => {
  const meta: MetaFrame = { type: 'META', filename: 'a.txt', size: 123 };
  assert.deepEqual(parseFrame(JSON.stringify(meta)), meta);
});

test('parseFrame round-trips an END frame', () => {
  const end: EndFrame = { type: 'END', hash: 'abc123' };
  assert.deepEqual(parseFrame(JSON.stringify(end)), end);
});

test('formatProgress draws an empty bar at 0%', () => {
  assert.equal(barOf(formatProgress(0, 100, Date.now())), LIGHT_SHADE.repeat(30));
});

test('formatProgress draws a half-filled bar at 50%', () => {
  assert.equal(barOf(formatProgress(50, 100, Date.now())), FULL_BLOCK.repeat(15) + LIGHT_SHADE.repeat(15));
});

test('formatProgress draws a full bar at 100%', () => {
  const line = formatProgress(100, 100, Date.now());
  assert.equal(barOf(line), FULL_BLOCK.repeat(30));
  assert.match(line, /100\.0%/);
});

test('formatProgress clamps when done exceeds total', () => {
  const line = formatProgress(150, 100, Date.now());
  assert.equal(barOf(line), FULL_BLOCK.repeat(30));
  assert.match(line, /100\.0%/);
});

test('formatProgress handles a zero-byte total without dividing by zero', () => {
  const line = formatProgress(0, 0, Date.now());
  assert.equal(barOf(line), LIGHT_SHADE.repeat(30));
  assert.doesNotMatch(line, /NaN|Infinity/);
});

test('formatProgress reports speed and ETA', () => {
  const line = formatProgress(1024 * 1024, 2 * 1024 * 1024, Date.now() - 1000);
  assert.match(line, /1\.00 MB\/s/);
  assert.match(line, /ETA 1s/);
});

test('renderProgress animates a simulated transfer', async (t) => {
  silenceProgress(t);

  const total = 250 * 1024 * 1024;
  const chunkSize = 64 * 1024;
  const targetMBs = 400;
  const tickMs = 16;

  const startTime = Date.now();
  let received = 0;

  while (received < total) {
    // jitter the rate so the speed/ETA readouts move like a real transfer
    const jitter = 0.6 * Math.random() + 0.8;
    const bytesThisTick = targetMBs * 1024 * 1024 * (tickMs / 1000) * jitter;
    const chunks = Math.max(1, Math.round(bytesThisTick / chunkSize));

    received = Math.min(total, received + chunks * chunkSize);
    renderProgress(received, total, startTime);
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }

  assert.equal(received, total);
});
