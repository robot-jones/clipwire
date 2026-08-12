import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type DataChannel } from './connection.js';
import { parseFrame, renderProgress, type MetaFrame } from './protocol.js';

export async function receiveFile(dc: DataChannel, destDir: string): Promise<void> {
  await new Promise<void>((resolve) => (dc.isOpen() ? resolve() : dc.onOpen(resolve)));

  return new Promise((resolve, reject) => {
    let meta: MetaFrame | null = null;
    let writeStream: ReturnType<typeof createWriteStream> | null = null;
    const hash = createHash('sha256');
    let received = 0;
    let startTime = 0;

    dc.onMessage((msg) => {
      if (typeof msg === 'string') {
        const frame = parseFrame(msg);

        if (frame.type === 'META') {
          meta = frame;
          startTime = Date.now();
          const dest = join(destDir, frame.filename);
          writeStream = createWriteStream(dest);
          writeStream.on('error', reject);
          console.log(`Receiving: ${frame.filename} (${(frame.size / 1024 / 1024).toFixed(2)} MB)`);
          console.log(''); // reserve line for progress bar
        } else if (frame.type === 'END') {
          writeStream?.end(() => {
            const actual = hash.digest('hex');
            if (actual !== frame.hash) {
              reject(new Error(`Hash mismatch - file may be corrupt.\n  expected: ${frame.hash}\n  got:      ${actual}`));
            } else {
              console.log(`\nFile received and verified: ${meta?.filename}`);
              resolve();
            }
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
