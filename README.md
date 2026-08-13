# clipwire

A terminal-based, point-to-point file sharing utility written in TypeScript and powered by Node.js. This tool allows two users behind arbitrary NATs/firewalls to stream files directly to each other without intermediate cloud servers, using manual clipboard-based signaling.

---

## Installation & Usage

No install step required - run it directly via `npx`:

```
npx github:robot-jones/clipwire
```

This clones the repo, builds it, and starts the interactive prompt. To skip the "Ok to proceed?" confirmation on repeat runs, add `--yes`:

```
npx --yes github:robot-jones/clipwire
```

---

## Tech Stack & Core Modules

* Runtime: Node.js (v18+)
* Language: TypeScript (configured with strict type-checking).
* WebRTC Implementation: node-datachannel
* Core Libraries:
  * node:fs / node:stream for memory-efficient file I/O and backpressure management.
  * node:crypto for calculating streaming SHA-256 integrity hashes
  * readline / enquirer for handling interactive terminal prompts

---

## System Architecture & Flow

Because this tool targets two explicit users who know each other, we bypass the need for a central signaling server by utilizing manual signaling (copy-pasting connection metadata via Slack, Teams, or Signal).

[ Sender (Peer A) ]                                        [ Receiver (Peer B) ]

        |                                                            |
        |---- 1. Generates SDP Offer + ICE Candidates -------------> | (Via Clipboard/Chat)
        |                                                            |
        | <-- 2. Inputs Offer & Generates SDP Answer ----------------| (Via Clipboard/Chat)
        |                                                            |
        | ========================================================== |
        |        STUN/TURN NAT Traversal occurs automatically        |
        |        Direct P2P DataChannel Connection Established       |
        | ========================================================== |
        |                                                            |
        |---- 3. Sends Metadata (Name, Size, Hash) ----------------> |
        |---- 4. Streams File Chunks (with Backpressure control) --> |
        |                                                            |

## 1. Connection Phase (Signaling)

  1. Peer A (Sender) initiates the app, selects a file, and generates a WebRTC Offer. The app base64-encodes the local Session Description Protocol (SDP) and prints it out.
  2. Peer A sends this string to Peer B via any messaging app.
  3. Peer B (Receiver) boots the app, selects "Receive", pastes Peer A's string, and generates an Answer string.
  4. Peer B sends the Answer back to Peer A, who pastes it into their terminal.
  5. WebRTC uses public STUN servers (e.g., Google's free STUN endpoints) to execute ICE hole punching and establish a direct connection.

## 2. Protocol & Data Transfer Phase

Once the RTCDataChannel opens, communication follows a mini-protocol using structured binary or JSON frames:

* Frame 1: Metadata (JSON String or Binary Header)

```json
{ "type": "META", "filename": "ubuntu.iso", "size": 4831838208, "hash": "e3b0c442..." }
```

* Frame 2..N: Data Chunks (Raw Binary)

The file is read in chunks (e.g., 16KB to 64KB) and sent down the data channel as ArrayBuffer / Uint8Array.

* Frame Final: Done Signal

```json
{ "type": "END" }
```

---

## Project Layout

```
clipwire/
├── src/
│   ├── index.ts                    # CLI entry point, argument parsing, interactive menu
│   ├── connection.ts                # WebRTC configuration, ICE management, signaling helpers
│   ├── protocol.ts                  # Frame serialization/deserialization & message types
│   ├── stream-sender.ts             # Logic for reading disk, handling backpressure & hashing
│   ├── stream-receiver.ts           # Logic for writing chunks to disk & progress tracking
│   ├── test-helpers.ts              # Shared test doubles/helpers (FakeChannel, silenceProgress, ...)
│   └── *.test.ts                    # Colocated unit tests, run via `npm test`
├── package.json
├── tsconfig.json                    # Full compile (source + tests) -> dist-test/, used by `npm test`
├── tsconfig.build.json              # Publishable compile (source only) -> dist/, used by `npm run build`
└── README.md
```

---

## Key Implementation Hurdles (The Fun Stuff)

## 1. Asynchronous ICE Gathering

WebRTC normally gathers network paths (ICE candidates) asynchronously. Since we do not have a live signaling server to trickle candidates one by one, you must wait for the candidate gathering process to complete fully before exporting the SDP string.

* Implementation Trick: Hook into onicegatheringstatechange and only output the base64 token when the state changes to 'complete'.

## 2. WebRTC Buffered Amount Backpressure

The RTCDataChannel has a fixed underlying network buffer (typically up to 16MB). If you pipe a fast NVMe SSD stream straight into the channel, you will blow up the memory and drop packets.

* Implementation Trick: Monitor dataChannel.bufferedAmount. If it exceeds a high-water mark (e.g., 4MB), pause the Node.js ReadableStream. Listen to the onbufferedamountlow event to resume reading from disk.

## 3. Terminal UX Control

To make it feel like a polished utility, use raw ANSI escape sequences (\x1b[A to move the cursor up, \x1b[2K to clear the line) to render a dynamic progress bar showing:

* Percentage completion
* Current throughput (MB/s) calculated via a rolling time window
* Estimated Time Remaining (ETA)
