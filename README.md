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
  * node:readline/promises for handling interactive terminal prompts

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
        |             STUN NAT Traversal occurs automatically        |
        |        Direct P2P DataChannel Connection Established       |
        | ========================================================== |
        |                                                            |
        |---- 3. Sends Metadata (Name, Size, Hash) ----------------> |
        |---- 4. Streams File Chunks (with Backpressure control) --> |
        | <--- 5. Receiver ACKs once the hash is verified -----------|
        |     (each side closes only after its own queue drains)     |
        |                                                            |

## 1. Connection Phase (Signaling)

  1. Peer A (Sender) initiates the app, selects a file, and generates a WebRTC Offer. The app base64-encodes the local Session Description Protocol (SDP) and prints it out.
  2. Peer A sends this string to Peer B via any messaging app.
  3. Peer B (Receiver) boots the app, selects "Receive", pastes Peer A's string, and generates an Answer string.
  4. Peer B sends the Answer back to Peer A, who pastes it into their terminal.
  5. WebRTC uses public STUN servers (e.g., Google's free STUN endpoints) to execute ICE hole punching and establish a direct connection.

  > **Note:** clipwire uses STUN only - there's no TURN/relay fallback, by design (no intermediate servers). This means it can't establish a direct connection when a peer's NAT/firewall doesn't allow the hole-punch through (e.g. some corporate networks, CGNAT, or a cloud firewall like an AWS Security Group that hasn't been opened for the connection - see `CLIPWIRE_PORT_MIN`/`CLIPWIRE_PORT_MAX` below). If both peers happen to be behind the same router, make sure Client/AP Isolation is off - that setting blocks device-to-device traffic even on the same network and looks identical to a NAT failure.

## 2. Protocol & Data Transfer Phase

Once the RTCDataChannel opens, communication follows a mini-protocol using structured binary or JSON frames:

* Frame 1: Metadata (JSON String or Binary Header)

```json
{ "type": "META", "filename": "ubuntu.iso", "size": 4831838208 }
```

* Frame 2..N: Data Chunks (Raw Binary)

The file is read in chunks (e.g., 16KB to 64KB) and sent down the data channel as ArrayBuffer / Uint8Array.

* Frame N+1: Done Signal

```json
{ "type": "END", "hash": "e3b0c442..." }
```

* Frame N+2: Acknowledgment (Receiver → Sender)

```json
{ "type": "ACK" }
```

The receiver sends this only after it has verified the streamed hash matches. The sender waits for it (and for its own send queue to fully drain) before closing the connection - closing right after queuing the last chunk is enough on loopback, but on a real network link it can tear the connection down before the data has actually finished transmitting.

---

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `CLIPWIRE_DEBUG=1` | Verbose WebRTC connection logging (ICE gathering, STUN connectivity checks, DTLS, etc.), for diagnosing a connection that hangs or fails to establish. |
| `CLIPWIRE_PORT_MIN` / `CLIPWIRE_PORT_MAX` | Pin the UDP port range used for the connection instead of a random OS-assigned port. Useful behind a firewall that polices inbound traffic independently of outbound (e.g. an AWS EC2 Security Group) - set both to the same small range on both ends, and open only that range inbound. |

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
* Gotcha: gathering can finish before that listener is even attached, especially on a fast/local network - the native binding only notifies on the *next* transition, so a listener registered after the fact misses it and hangs forever. Attach the listener first, then immediately re-check the current state to catch up on anything already missed. The same pattern applies to every other async state watched here (connection state, ICE state, buffered amount).

## 2. WebRTC Buffered Amount Backpressure

The RTCDataChannel has a fixed underlying network buffer (typically up to 16MB). If you pipe a fast NVMe SSD stream straight into the channel, you will blow up the memory and drop packets.

* Implementation Trick: Monitor dataChannel.bufferedAmount. If it exceeds a high-water mark (e.g., 4MB), pause the Node.js ReadableStream. Listen to the onbufferedamountlow event to resume reading from disk.

## 3. Closing the Connection Without Losing Data

Handing the last chunk to `sendMessageBinary()` only queues it locally - it says nothing about whether the bytes have actually left the machine, let alone arrived. Closing the connection right after the read stream ends is invisible on loopback (near-zero latency leaves no meaningful gap), but over a real network link it can tear the connection down mid-flight and silently truncate the transfer.

* Implementation Trick: after sending the final frame, wait for `bufferedAmount()` to actually reach 0, then wait for an application-level ACK frame from the receiver (sent only after it verifies the hash) before closing. The receiver does the same drain-wait after sending its ACK, so the ACK itself isn't dropped by closing right behind it.

## 4. Terminal UX Control

To make it feel like a polished utility, use raw ANSI escape sequences (\x1b[A to move the cursor up, \x1b[2K to clear the line) to render a dynamic progress bar showing:

* Percentage completion
* Current throughput (MB/s) calculated via a rolling time window
* Estimated Time Remaining (ETA)
