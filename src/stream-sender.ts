import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { type DataChannel } from './connection.js';
import { renderProgress, type MetaFrame, type EndFrame } from './protocol.js';

const CHUNK_SIZE = 64 * 1024;              // 64KB read chunks
const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // 4MB pause threshold

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
  console.log('File sent successfully.');
}
