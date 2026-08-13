export const FULL_BLOCK = '█';
export const LIGHT_SHADE = '░';

export interface MetaFrame {
  type: 'META';
  filename: string;
  size: number;
}

// Hash is sent in END rather than META so it can be computed while streaming
export interface EndFrame {
  type: 'END';
  hash: string;
}

// Sent by the receiver once it has verified the hash. The sender waits for
// this before closing the connection - without it, closing right after
// queuing the last chunk can tear down the link before the data has
// actually finished transmitting over a real (non-loopback) network.
export interface AckFrame {
  type: 'ACK';
}

export type Frame = MetaFrame | EndFrame | AckFrame;

export function parseFrame(msg: string): Frame {
  return JSON.parse(msg) as Frame;
}

const BAR_WIDTH = 30;

export function formatProgress(done: number, total: number, startTime: number): string {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const pct = ratio * 100;
  const elapsed = (Date.now() - startTime) / 1000 || 0.001;
  const speedMBs = done / elapsed / (1024 * 1024);
  const etaSec = speedMBs > 0 ? (total - done) / (speedMBs * 1024 * 1024) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const bar = FULL_BLOCK.repeat(filled) + LIGHT_SHADE.repeat(BAR_WIDTH - filled);
  return `[${bar}] ${pct.toFixed(1).padStart(5)}% | ${speedMBs.toFixed(2)} MB/s | ETA ${etaSec.toFixed(0)}s`;
}

export function renderProgress(done: number, total: number, startTime: number): void {
  process.stdout.write(`\x1b[1A\x1b[2K${formatProgress(done, total, startTime)}\n`);
}
