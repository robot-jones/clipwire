import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { type DataChannel } from './connection.js';

type Message = string | Buffer;

/** A minimal in-memory stand-in for node-datachannel's DataChannel, for tests that drive receiveFile/sendFile directly. */
export class FakeChannel {
  private handler: ((msg: Message) => void) | null = null;

  /** Messages passed to sendMessage/sendMessageBinary, in order, for assertions. */
  sent: Message[] = [];

  isOpen(): boolean {
    return true;
  }

  onOpen(cb: () => void): void {
    cb();
  }

  onMessage(cb: (msg: Message) => void): void {
    this.handler = cb;
  }

  emit(msg: Message): void {
    assert.ok(this.handler, 'handler was never registered');
    this.handler(msg);
  }

  sendMessage(msg: string): boolean {
    this.sent.push(msg);
    return true;
  }

  sendMessageBinary(buf: Buffer): boolean {
    this.sent.push(buf);
    return true;
  }

  // No real network queue to drain, so there's nothing buffered - always
  // "caught up" the instant it's checked.
  bufferedAmount(): number {
    return 0;
  }

  setBufferedAmountLowThreshold(_bytes: number): void {}

  onBufferedAmountLow(cb: () => void): void {
    cb();
  }

  onClosed(_cb: () => void): void {}

  close(): void {}

  asDataChannel(): DataChannel {
    return this as unknown as DataChannel;
  }
}

// receiveFiles/sendFiles register handlers/kick off I/O after an awaited
// open check or a real fs read, so a single microtask tick isn't always
// enough to observe their next side effect.
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Polls `predicate` once per tick until it's true, for tests that need to
// react to a real (non-instant) async side effect - e.g. a FakeChannel
// message emitted only after sendFiles has actually finished reading a
// chunk of a file off disk - without hardcoding a fixed number of flushes
// and risking flakiness.
export async function waitUntil(predicate: () => boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`waitUntil: condition not met within ${maxTicks} ticks`);
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-recv-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// receiveFile logs a couple of status lines via console.log and renders an
// in-place progress bar via raw ANSI escapes on process.stdout.write. Mocking
// process.stdout.write wholesale would also swallow the test runner's own
// TAP output (which goes through the same stream), so only the progress
// bar's escape-coded writes are filtered; everything else passes through.
export function silenceProgress(t: TestContext): void {
  t.mock.method(console, 'log', () => {});

  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    if (typeof chunk === 'string' && chunk.startsWith('\x1b')) return true;
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = originalWrite;
  });
}
