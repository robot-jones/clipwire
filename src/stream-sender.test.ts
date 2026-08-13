import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectFiles, sendFiles } from './stream-sender.js';
import type { EndFrame, MetaFrame } from './protocol.js';
import { FakeChannel, silenceProgress, waitUntil, withTempDir } from './test-helpers.js';

test('collectFiles keeps a plain file under its bare basename', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'hi');

    assert.deepEqual(collectFiles([file]), [{ absPath: file, relPath: 'note.txt' }]);
  });
});

test('collectFiles recurses into a folder with posix-style, sorted relative paths', async () => {
  await withTempDir(async (dir) => {
    const folder = join(dir, 'Photos');
    mkdirSync(join(folder, 'trip'), { recursive: true });
    writeFileSync(join(folder, 'b.jpg'), '2');
    writeFileSync(join(folder, 'a.jpg'), '1');
    writeFileSync(join(folder, 'trip', 'c.jpg'), '3');

    const entries = collectFiles([folder]);
    assert.deepEqual(entries.map((e) => e.relPath), ['Photos/a.jpg', 'Photos/b.jpg', 'Photos/trip/c.jpg']);
  });
});

test('collectFiles skips symlinks rather than following them', async () => {
  await withTempDir(async (dir) => {
    const folder = join(dir, 'stuff');
    mkdirSync(folder);
    writeFileSync(join(folder, 'real.txt'), 'real');
    symlinkSync(join(folder, 'real.txt'), join(folder, 'link.txt'));

    const entries = collectFiles([folder]);
    assert.deepEqual(entries.map((e) => e.relPath), ['stuff/real.txt']);
  });
});

test('collectFiles throws for a path that does not exist', () => {
  assert.throws(() => collectFiles(['/no/such/path']), /No such file or directory/);
});

test('sendFiles sends META/data/END for each entry in order and waits for each ACK', async (t) => {
  silenceProgress(t);

  await withTempDir(async (dir) => {
    const fileA = join(dir, 'a.txt');
    const fileB = join(dir, 'b.txt');
    writeFileSync(fileA, 'hello');
    writeFileSync(fileB, 'world!!');

    const dc = new FakeChannel();
    const entries = [
      { absPath: fileA, relPath: 'a.txt' },
      { absPath: fileB, relPath: 'b.txt' },
    ];

    const isEndFrame = (m: string | Buffer) => typeof m === 'string' && (JSON.parse(m) as { type: string }).type === 'END';
    const done = sendFiles(dc.asDataChannel(), entries);

    // Simulate the receiver ACKing each file as its END frame arrives.
    for (let i = 0; i < entries.length; i++) {
      await waitUntil(() => dc.sent.filter(isEndFrame).length > i);
      dc.emit(JSON.stringify({ type: 'ACK' }));
    }

    await done;

    const strings = dc.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m));
    const metas = strings.filter((f) => f.type === 'META') as MetaFrame[];
    const ends = strings.filter((f) => f.type === 'END') as EndFrame[];

    assert.deepEqual(
      metas.map((m) => [m.filename, m.index, m.total]),
      [['a.txt', 0, 2], ['b.txt', 1, 2]],
    );
    assert.deepEqual(
      ends.map((e) => e.hash),
      [createHash('sha256').update('hello').digest('hex'), createHash('sha256').update('world!!').digest('hex')],
    );
  });
});
