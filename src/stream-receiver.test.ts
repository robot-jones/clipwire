import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { receiveFile } from './stream-receiver.js';
import type { EndFrame, MetaFrame } from './protocol.js';
import { FakeChannel, flush, silenceProgress, withTempDir } from './test-helpers.js';

test('receiveFile writes the streamed chunks and verifies the hash', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const payload = Buffer.from('hello peer-to-peer world');
    const dc = new FakeChannel();
    const done = receiveFile(dc.asDataChannel(), dir);
    await flush();

    const meta: MetaFrame = { type: 'META', filename: 'greetings.txt', size: payload.length };
    dc.emit(JSON.stringify(meta));
    dc.emit(payload.subarray(0, 10));
    dc.emit(payload.subarray(10));

    const end: EndFrame = { type: 'END', hash: createHash('sha256').update(payload).digest('hex') };
    dc.emit(JSON.stringify(end));

    await done;
    assert.deepEqual(readFileSync(join(dir, 'greetings.txt')), payload);
  });
});

test('receiveFile rejects when the hash does not match', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const dc = new FakeChannel();
    const done = receiveFile(dc.asDataChannel(), dir);
    await flush();

    const meta: MetaFrame = { type: 'META', filename: 'corrupt.bin', size: 4 };
    dc.emit(JSON.stringify(meta));
    dc.emit(Buffer.from('data'));

    const end: EndFrame = { type: 'END', hash: 'not-the-real-hash' };
    dc.emit(JSON.stringify(end));

    await assert.rejects(done, /Hash mismatch/);
  });
});
