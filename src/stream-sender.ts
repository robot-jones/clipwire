import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { type DataChannel, waitForDrain } from './connection.js';
import { parseFrame, renderProgress, type MetaFrame, type EndFrame } from './protocol.js';

const CHUNK_SIZE = 64 * 1024;              // 64KB read chunks
const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // 4MB pause threshold
const ACK_TIMEOUT_MS = 30_000;

export interface FileEntry {
  /** Absolute path to the file on the sender's local disk. */
  absPath: string;
  /** Path sent to the receiver in the META frame - see MetaFrame.filename. */
  relPath: string;
}

// Recursively lists the files under `dir`, prefixing each with `relBase`
// (always joined with "/", regardless of host OS) so the wire format stays
// OS-independent. Symlinks are deliberately skipped rather than followed -
// that keeps a transfer scoped to files actually inside the given folder and
// avoids the possibility of a symlink cycle turning this into an infinite
// loop. Sorted so recursive transfers are deterministic (readdir order isn't
// guaranteed), while the order paths were typed in is preserved for
// top-level entries by the caller.
function walk(dir: string, relBase: string, out: FileEntry[]): void {
  const dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of dirents) {
    const abs = join(dir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      out.push({ absPath: abs, relPath: rel });
    }
  }
}

// Expands the paths a user typed at the send prompt into a flat list of
// files to transfer. A directory is recursed into and its own name becomes
// the top segment of each contained file's relPath, so the folder structure
// survives on the receiving end; a plain file is sent under its bare
// basename, same as a single-file transfer always has been.
//
// Note: two standalone files with the same basename (or a standalone file
// whose basename collides with something inside a recursed folder) will
// overwrite each other on the receiving end - relPaths aren't deduplicated.
export function collectFiles(paths: string[]): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      throw new Error(`No such file or directory: ${p}`);
    }
    if (statSync(p).isDirectory()) {
      walk(p, basename(p), entries);
    } else {
      entries.push({ absPath: p, relPath: basename(p) });
    }
  }
  return entries;
}

function waitForAck(dc: DataChannel, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Timed out after ${timeoutMs / 1000}s waiting for the receiver to acknowledge the transfer. The ` +
        'connection may have dropped before the receiver finished verifying the file.'
      ));
    }, timeoutMs);

    dc.onMessage((msg) => {
      if (typeof msg !== 'string') return;
      if (parseFrame(msg).type === 'ACK') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function sendOneFile(dc: DataChannel, entry: FileEntry, index: number, total: number): Promise<void> {
  const { size } = statSync(entry.absPath);

  const meta: MetaFrame = { type: 'META', filename: entry.relPath, size, index, total };
  dc.sendMessage(JSON.stringify(meta));

  dc.setBufferedAmountLowThreshold(BUFFER_HIGH_WATER / 2);

  const hash = createHash('sha256');
  const stream = createReadStream(entry.absPath, { highWaterMark: CHUNK_SIZE });
  let sent = 0;
  const startTime = Date.now();

  const label = total > 1 ? `Sending ${index + 1}/${total}: ` : 'Sending: ';
  console.log(`\n${label}${entry.relPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(''); // reserve line for progress bar

  await new Promise<void>((resolve, reject) => {
    dc.onBufferedAmountLow(() => stream.resume());

    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      hash.update(buf);
      dc.sendMessageBinary(buf);
      sent += buf.length;
      renderProgress(sent, size, startTime);
      if (dc.bufferedAmount() > BUFFER_HIGH_WATER) stream.pause();
    });

    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const end: EndFrame = { type: 'END', hash: hash.digest('hex') };
  dc.sendMessage(JSON.stringify(end));

  // Make sure the END frame (and everything before it) has actually left
  // the local send queue, then wait for the receiver's ACK confirming it
  // got everything and the hash matched, before moving on to the next file
  // (or letting the caller close the connection) - doing that any earlier
  // risks tearing down the link while data is still in flight.
  await waitForDrain(dc);
  await waitForAck(dc, ACK_TIMEOUT_MS);
}

// Sends every entry over the same already-open data channel, one after
// another - a single offer/answer exchange sets up the channel once, and
// this loop is what lets that one connection carry any number of files.
export async function sendFiles(dc: DataChannel, entries: FileEntry[]): Promise<void> {
  await new Promise<void>((resolve) => (dc.isOpen() ? resolve() : dc.onOpen(resolve)));

  for (const [i, entry] of entries.entries()) {
    await sendOneFile(dc, entry, i, entries.length);
  }

  console.log(entries.length > 1 ? `\nAll ${entries.length} files sent successfully.` : '\nFile sent successfully.');
}
