import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { type DataChannel, waitForDrain } from './connection.js';
import { parseFrame, renderProgress, type MetaFrame, type EndFrame } from './protocol.js';

const CHUNK_SIZE = 64 * 1024;              // 64KB read chunks
const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // 4MB pause threshold
const ACK_TIMEOUT_MS = 30_000;

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

export async function sendFile(dc: DataChannel, filePath: string): Promise<void> {
  await new Promise<void>((resolve) => (dc.isOpen() ? resolve() : dc.onOpen(resolve)));

  const { size } = statSync(filePath);
  const filename = basename(filePath);

  const meta: MetaFrame = { type: 'META', filename, size };
  dc.sendMessage(JSON.stringify(meta));

  dc.setBufferedAmountLowThreshold(BUFFER_HIGH_WATER / 2);

  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  let sent = 0;
  const startTime = Date.now();

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
  // got everything and the hash matched, before returning. The caller
  // closes the connection right after this resolves - doing that any
  // earlier risks tearing down the link while data is still in flight.
  await waitForDrain(dc);
  await waitForAck(dc, ACK_TIMEOUT_MS);

  console.log('File sent successfully.');
}
