#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import nodeDataChannel from 'node-datachannel';
import { createOffer, createAnswer, watchConnection } from './connection.js';
import { sendFile } from "./stream-sender.js";
import { receiveFile } from "./stream-receiver.js";

const rl = createInterface({ input, output });

// Resolve a user-typed file path, expanding a leading "~" to the home
// directory. This is normally the shell's job, but it doesn't apply here -
// the path is typed into an interactive prompt, not passed as a shell
// argument, so Node never sees the expansion and would otherwise look for a
// literal directory named "~".
function resolveFilePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return homedir() + trimmed.slice(1);
  return trimmed;
}

// Decode a pasted offer/answer token and sanity-check it's actually SDP text
// (starts with "v=0" per RFC 8866) before handing it to node-datachannel.
// Copy-pasting a long single-line base64 blob through email/chat apps can
// silently mangle it (line-wrap reformatting, quoted-printable artifacts,
// autocorrect, accidentally copying a link instead of the text, ...), and
// without this check a corrupted token just causes the app to hang later
// with no explanation, indistinguishable from a real network failure.
function decodeToken(token: string, label: string): string {
  const sdp = Buffer.from(token.trim(), 'base64').toString('utf8');
  if (!sdp.startsWith('v=0')) {
    throw new Error(
      `The pasted ${label} doesn't look like valid SDP (expected it to start with "v=0"). It was likely ` +
      'corrupted when copied - e.g. reformatted by an email client or chat app. Double-check you copied the ' +
      'entire token exactly, with nothing added or missing, and try again.'
    );
  }
  return sdp;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: clipwire [--help]\n' +
    '\n' +
    'Interactive P2P file transfer over WebRTC (no server required).\n' +
    '\n' +
    'Steps:\n' +
    '  Sender   : choose (s)end, enter a file path, share the offer token\n' +
    '  Receiver : choose (r)eceive, paste the offer token, share answer token\n' +
    '  Sender   : paste the answer token - transfer begins automatically\n' +
    '\n' +
    'Env vars:\n' +
    '  CLIPWIRE_DEBUG=1        Verbose WebRTC connection logging, for diagnosing\n' +
    '                          a connection that hangs or fails to establish.\n' +
    '  CLIPWIRE_PORT_MIN/MAX   Pin the UDP port range used for the connection,\n' +
    '                          e.g. behind a firewall that needs a specific\n' +
    '                          inbound port range opened (like an AWS Security\n' +
    '                          Group). Set both to the same small range on both\n' +
    '                          ends.'
  );
  process.exit(0);
}

async function main() {
  console.log('clipwire\n');

  const answer = await rl.question('Do you want to (s)end or (r)eceive? ');
  const choice = answer.trim().toLowerCase();

  if (choice === 's' || choice === 'send') {
    await send();
  } else if (choice === 'r' || choice === 'receive') {
    await receive();
  } else {
    console.error('Invalid choice. Please enter "s" or "r".');
    process.exit(1);
  }

  rl.close()
}

async function send() {
  const filePath = resolveFilePath(await rl.question('File path to send: '));
  if (!existsSync(filePath)) {
    throw new Error(`No such file: ${filePath}`);
  }

  console.log('\nGenerating offer, gathering ICE candidates...');
  const { pc, dc, offerSdp } = await createOffer();

  const offerToken = Buffer.from(offerSdp).toString('base64');
  console.log('\n--- YOUR OFFER (copy and send to receiver) ---');
  console.log(offerToken);
  console.log('----------------------------------------------\n');

  const answerToken = await rl.question('Paste receiver\'s answer: ');
  const answerSdp = decodeToken(answerToken, 'answer');
  pc.setRemoteDescription(answerSdp, 'answer');

  console.log('\nConnecting...');
  // Both sides now have everything they need, so a real connection attempt
  // is genuinely underway - a bounded timeout is meaningful here.
  await watchConnection(pc, 'sender', 30_000);
  await sendFile(dc, filePath);
  pc.close();
}

async function receive() {
  const offerToken = await rl.question('Paste sender\'s offer: ');
  const offerSdp = decodeToken(offerToken, 'offer');

  console.log('\nGenerating answer, gathering ICE candidates...');
  const { pc, dc, answerSdp } = await createAnswer(offerSdp);

  const answerToken = Buffer.from(answerSdp).toString('base64');
  console.log('\n--- YOUR ANSWER (copy and send to sender) ---');
  console.log(answerToken);
  console.log('---------------------------------------------\n');

  console.log('Waiting for connection...');
  // No timeout here: from this side there's no way to know how long the
  // sender will take to receive this answer and apply it (manual, often
  // over email) - only a definitive failure should end the wait.
  await watchConnection(pc, 'receiver');
  const channel = await dc;
  await receiveFile(channel, process.cwd());
  pc.close();
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  // node-datachannel spawns a background native worker-thread pool at load
  // time to drive its own event loop, which otherwise keeps the process
  // alive indefinitely even after every PeerConnection has been closed -
  // shut it down explicitly so the process exits naturally once we're done,
  // instead of the transfer finishing but the terminal never returning.
  nodeDataChannel.cleanup();
}
