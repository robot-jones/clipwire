#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createOffer, createAnswer } from './connection.js';
import { sendFile } from "./stream-sender.js";
import { receiveFile } from "./stream-receiver.js";

const rl = createInterface({ input, output });

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: clipwire [--help]\n' +
    '\n' +
    'Interactive P2P file transfer over WebRTC (no server required).\n' +
    '\n' +
    'Steps:\n' +
    '  Sender   : choose (s)end, enter a file path, share the offer token\n' +
    '  Receiver : choose (r)eceive, paste the offer token, share answer token\n' +
    '  Sender   : paste the answer token - transfer begins automatically'
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
  const filePath = await rl.question('File path to send: ');

  console.log('\nGenerating offer, gathering ICE candidates...');
  const { pc, dc, offerSdp } = await createOffer();

  const offerToken = Buffer.from(offerSdp).toString('base64');
  console.log('\n--- YOUR OFFER (copy and send to receiver) ---');
  console.log(offerToken);
  console.log('----------------------------------------------\n');

  const answerToken = await rl.question('Paste receiver\'s answer: ');
  const answerSdp = Buffer.from(answerToken.trim(), 'base64').toString('utf8');
  pc.setRemoteDescription(answerSdp, 'answer');

  console.log('\nConnecting...');
  await sendFile(dc, filePath);
  pc.close();
}

async function receive() {
  const offerToken = await rl.question('Paste sender\'s offer: ');
  const offerSdp = Buffer.from(offerToken.trim(), 'base64').toString('utf8');

  console.log('\nGenerating answer, gathering ICE candidates...');
  const { pc, dc, answerSdp } = await createAnswer(offerSdp);

  const answerToken = Buffer.from(answerSdp).toString('base64');
  console.log('\n--- YOUR ANSWER (copy and send to sender) ---');
  console.log(answerToken);
  console.log('---------------------------------------------\n');

  console.log('Waiting for connection...');
  await receiveFile(dc, process.cwd());
  pc.close();
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
