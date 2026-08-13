import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { type DataChannel, waitForDrain } from './connection.js';
import { parseFrame, renderProgress, type AckFrame, type MetaFrame } from './protocol.js';

// Turns a peer-supplied relative path (forward-slash separated, e.g. from a
// recursed folder - see MetaFrame.filename) into a safe filesystem path
// under destDir. The sender is a trusted peer for the *content* of a
// transfer, but this string still needs validating: an "../" segment or an
// absolute path is a classic zip-slip-style escape that would otherwise let
// a malicious or buggy peer write outside the chosen destination directory.
function resolveSafeDest(destDir: string, relPath: string): string {
  // The wire format only ever uses "/" (see stream-sender.ts's walk()), so a
  // backslash - along with a leading "/" or a Windows drive letter - is
  // always treated as an unsafe/ambiguous path rather than interpreted.
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath) || relPath.includes('\\')) {
    throw new Error(`Refusing to write to unsafe path from peer: "${relPath}"`);
  }

  const segments = relPath.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    throw new Error(`Refusing to write to unsafe path from peer: "${relPath}"`);
  }

  const root = resolve(destDir);
  const dest = resolve(root, ...segments);
  if (dest !== root && !dest.startsWith(root + sep)) {
    throw new Error(`Refusing to write to unsafe path from peer: "${relPath}"`);
  }
  return dest;
}

// Receives every file the sender streams over dc, in order, resolving once
// the last one (per its META.total) has been written and ACKed. A single
// offer/answer exchange sets up the data channel once; this loop is what
// lets that one connection carry any number of files, so it keeps listening
// for the next META frame instead of resolving after the first file.
export async function receiveFiles(dc: DataChannel, destDir: string): Promise<void> {
  await new Promise<void>((resolve) => (dc.isOpen() ? resolve() : dc.onOpen(resolve)));

  return new Promise((resolve, reject) => {
    let meta: MetaFrame | null = null;
    let writeStream: ReturnType<typeof createWriteStream> | null = null;
    let hash = createHash('sha256');
    let received = 0;
    let startTime = 0;
    let completed = 0;

    dc.onMessage((msg) => {
      if (typeof msg === 'string') {
        const frame = parseFrame(msg);

        if (frame.type === 'META') {
          meta = frame;
          hash = createHash('sha256');
          received = 0;
          startTime = Date.now();

          let dest: string;
          try {
            dest = resolveSafeDest(destDir, frame.filename);
          } catch (err) {
            reject(err);
            return;
          }
          mkdirSync(dirname(dest), { recursive: true });
          writeStream = createWriteStream(dest);
          writeStream.on('error', reject);

          const label = frame.total > 1 ? `Receiving ${frame.index + 1}/${frame.total}: ` : 'Receiving: ';
          console.log(`${label}${frame.filename} (${(frame.size / 1024 / 1024).toFixed(2)} MB)`);
          console.log(''); // reserve line for progress bar
        } else if (frame.type === 'END') {
          // Snapshot meta/hash before the write stream's callback fires -
          // both outer variables get reassigned as soon as the *next*
          // file's META frame arrives, which can happen before this file's
          // async write actually finishes flushing to disk.
          const finishedMeta = meta;
          const finishedHash = hash;
          writeStream?.end(() => {
            const actual = finishedHash.digest('hex');
            if (actual !== frame.hash) {
              reject(new Error(`Hash mismatch - file may be corrupt.\n  expected: ${frame.hash}\n  got:      ${actual}`));
              return;
            }

            console.log(`\nFile received and verified: ${finishedMeta?.filename}`);
            const ack: AckFrame = { type: 'ACK' };
            dc.sendMessage(JSON.stringify(ack));
            completed += 1;
            const total = finishedMeta?.total ?? 1;

            // Wait for the ACK to actually leave the local send queue before
            // resolving/moving on - the caller closes the connection right
            // after this whole session resolves, and closing too early
            // could drop the last ACK before the sender ever sees it.
            waitForDrain(dc).then(() => {
              if (completed >= total) {
                if (total > 1) console.log(`\nAll ${total} files received and verified.`);
                resolve();
              }
              // Otherwise keep listening - the sender's next META is next.
            }, reject);
          });
        }
      } else {
        const chunk = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
        hash.update(chunk);
        writeStream?.write(chunk);
        received += chunk.length;
        if (meta) renderProgress(received, meta.size, startTime);
      }
    });
  });
}
