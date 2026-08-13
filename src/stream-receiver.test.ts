import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { receiveFiles } from './stream-receiver.js';
import type { EndFrame, MetaFrame } from './protocol.js';
import { FakeChannel, flush, silenceProgress, withTempDir } from './test-helpers.js';

test('receiveFiles writes the streamed chunks and verifies the hash', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const payload = Buffer.from('hello peer-to-peer world');
    const dc = new FakeChannel();
    const done = receiveFiles(dc.asDataChannel(), dir);
    await flush();

    const meta: MetaFrame = { type: 'META', filename: 'greetings.txt', size: payload.length, index: 0, total: 1 };
    dc.emit(JSON.stringify(meta));
    dc.emit(payload.subarray(0, 10));
    dc.emit(payload.subarray(10));

    const end: EndFrame = { type: 'END', hash: createHash('sha256').update(payload).digest('hex') };
    dc.emit(JSON.stringify(end));

    await done;
    assert.deepEqual(readFileSync(join(dir, 'greetings.txt')), payload);
    assert.deepEqual(dc.sent, [JSON.stringify({ type: 'ACK' })]);
  });
});

test('receiveFiles rejects when the hash does not match', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const dc = new FakeChannel();
    const done = receiveFiles(dc.asDataChannel(), dir);
    await flush();

    const meta: MetaFrame = { type: 'META', filename: 'corrupt.bin', size: 4, index: 0, total: 1 };
    dc.emit(JSON.stringify(meta));
    dc.emit(Buffer.from('data'));

    const end: EndFrame = { type: 'END', hash: 'not-the-real-hash' };
    dc.emit(JSON.stringify(end));

    await assert.rejects(done, /Hash mismatch/);
  });
});

test('receiveFiles handles multiple files over a single session', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const dc = new FakeChannel();
    const done = receiveFiles(dc.asDataChannel(), dir);
    await flush();

    const payloadA = Buffer.from('first file');
    const metaA: MetaFrame = { type: 'META', filename: 'a.txt', size: payloadA.length, index: 0, total: 2 };
    dc.emit(JSON.stringify(metaA));
    dc.emit(payloadA);
    dc.emit(JSON.stringify({ type: 'END', hash: createHash('sha256').update(payloadA).digest('hex') } satisfies EndFrame));
    await flush();

    const payloadB = Buffer.from('second file, a bit longer this time');
    const metaB: MetaFrame = { type: 'META', filename: 'b.txt', size: payloadB.length, index: 1, total: 2 };
    dc.emit(JSON.stringify(metaB));
    dc.emit(payloadB);
    dc.emit(JSON.stringify({ type: 'END', hash: createHash('sha256').update(payloadB).digest('hex') } satisfies EndFrame));

    await done;
    assert.deepEqual(readFileSync(join(dir, 'a.txt')), payloadA);
    assert.deepEqual(readFileSync(join(dir, 'b.txt')), payloadB);
    assert.deepEqual(dc.sent, [JSON.stringify({ type: 'ACK' }), JSON.stringify({ type: 'ACK' })]);
  });
});

test('receiveFiles recreates nested directories from a folder-recursed relative path', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const dc = new FakeChannel();
    const done = receiveFiles(dc.asDataChannel(), dir);
    await flush();

    const payload = Buffer.from('nested file contents');
    const meta: MetaFrame = { type: 'META', filename: 'Photos/trip/pic.jpg', size: payload.length, index: 0, total: 1 };
    dc.emit(JSON.stringify(meta));
    dc.emit(payload);
    dc.emit(JSON.stringify({ type: 'END', hash: createHash('sha256').update(payload).digest('hex') } satisfies EndFrame));

    await done;
    assert.deepEqual(readFileSync(join(dir, 'Photos', 'trip', 'pic.jpg')), payload);
  });
});

test('receiveFiles rejects a relative path that escapes the destination directory', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const dc = new FakeChannel();
    const done = receiveFiles(dc.asDataChannel(), dir);
    await flush();

    const meta: MetaFrame = { type: 'META', filename: '../evil.txt', size: 4, index: 0, total: 1 };
    dc.emit(JSON.stringify(meta));

    await assert.rejects(done, /Refusing to write/);
    assert.equal(existsSync(join(dir, '..', 'evil.txt')), false);
  });
});

test('receiveFiles rejects an absolute path', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const dc = new FakeChannel();
    const done = receiveFiles(dc.asDataChannel(), dir);
    await flush();

    const meta: MetaFrame = { type: 'META', filename: '/etc/passwd', size: 4, index: 0, total: 1 };
    dc.emit(JSON.stringify(meta));

    await assert.rejects(done, /Refusing to write/);
  });
});
