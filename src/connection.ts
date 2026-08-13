import nodeDataChannel, { type DataChannel } from 'node-datachannel';

export type { DataChannel };

// Set CLIPWIRE_DEBUG=1 for verbose libdatachannel logging (ICE gathering,
// STUN connectivity checks, DTLS, etc.) - useful when a connection hangs or
// fails and watchConnection()'s state-change summary isn't enough detail.
// Gated behind an env var rather than always-on: initLogger() spawns native
// worker threads as a side effect, which keeps the process alive and would
// otherwise hang `npm test` (some test files import this module for its
// other side effects).
if (process.env.CLIPWIRE_DEBUG) {
  nodeDataChannel.initLogger('Debug', (level, message) => {
    console.error(`[node-datachannel:${level}] ${message}`);
  });
}

// CLIPWIRE_PORT_MIN/CLIPWIRE_PORT_MAX pin ICE candidates to a specific UDP
// port range instead of a random OS-assigned ephemeral port. Not needed on
// a normal home connection (NAT allows return traffic on whatever port was
// used to send out), but useful behind a stateful firewall that also polices
// *inbound* UDP independently of outbound traffic (e.g. an AWS EC2 Security
// Group) - pin a small range here and open that same range for the peer's
// IP in the firewall, rather than the entire ephemeral range.
const portRangeBegin = process.env.CLIPWIRE_PORT_MIN ? Number(process.env.CLIPWIRE_PORT_MIN) : undefined;
const portRangeEnd = process.env.CLIPWIRE_PORT_MAX ? Number(process.env.CLIPWIRE_PORT_MAX) : undefined;

const rtcConfig: nodeDataChannel.RtcConfig = {
  iceServers: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
  ],
  ...(portRangeBegin !== undefined && { portRangeBegin }),
  ...(portRangeEnd !== undefined && { portRangeEnd }),
};

// Reports connection progress to stderr and resolves once the peers actually
// establish a direct link, or rejects on failure/timeout. Without this,
// a NAT/firewall that can't be traversed (no relay/TURN server is used here)
// or corrupted offer/answer text looks identical to the user: the app just
// hangs forever with no explanation.
//
// Call this once the local side has done everything it can (i.e. right after
// applying the final remote description) - NOT eagerly at PeerConnection
// creation. The offer/answer exchange itself is manual and can take an
// arbitrary amount of time (copy-pasting through email, etc.); starting a
// timeout clock before that exchange finishes means it can fire while the
// caller is still waiting on human input rather than actually attempting to
// connect, and since nothing would be awaiting the promise yet at that point,
// Node treats the rejection as unhandled and kills the whole process.
//
// `timeoutMs` is optional: pass it only when the caller can be sure a
// connection attempt is actually underway (see createOffer/createAnswer
// callers). Without it, this only ever settles on a definitive native
// 'connected'/'failed'/'closed' signal - appropriate when there's no local
// way to know how much of the wait is just pending human/email coordination.
export function watchConnection(pc: nodeDataChannel.PeerConnection, label: string, timeoutMs?: number): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;

    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `[${label}] Timed out after ${timeoutMs / 1000}s waiting for a direct connection to the other peer. ` +
        'This usually means NAT/firewall traversal failed (clipwire uses STUN only, no relay server), or the ' +
        'offer/answer text got corrupted in transit before it was applied.'
      ));
    }, timeoutMs);

    const checkState = (state: string) => {
      // Once settled, later transitions (routine ICE/keepalive churn,
      // eventual close once the transfer finishes, ...) are no longer
      // useful to report - state-change diagnostics only matter while we're
      // still trying to establish the connection. Logging them anyway would
      // also interleave with the progress bar's own stdout writes during a
      // transfer, corrupting its in-place redraw.
      if (settled) return;
      console.error(`[${label}] connection state: ${state}`);
      if (state === 'connected') {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      } else if (state === 'failed' || state === 'closed') {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new Error(
          `[${label}] Connection ${state}. This usually means NAT/firewall traversal failed, or the ` +
          'offer/answer text got corrupted in transit.'
        ));
      }
    };

    pc.onStateChange(checkState);
    pc.onIceStateChange((state) => {
      if (settled) return; // see the comment in checkState() above
      console.error(`[${label}] ICE state: ${state}`);
    });
    // Catch up in case the state already moved before this listener was
    // attached (pc.state() reflects the current state regardless of timing,
    // unlike the event, which only fires on the *next* transition).
    checkState(pc.state());
  });

  // Even called at the "right" moment, the caller may not `await` this
  // immediately (e.g. the receiver waits on the data channel promise too).
  // Mark it observed so a rejection can never crash the process outright -
  // whoever actually awaits the returned promise still sees the real error.
  promise.catch(() => {});

  return promise;
}

// Resolves once a data channel's outbound send queue has actually drained,
// rather than just been handed off. sendMessage()/sendMessageBinary() only
// queue data locally - closing the connection right after calling them
// (rather than after this resolves) can tear it down before the data has
// actually left the machine, silently truncating a transfer. Invisible on
// loopback (near-zero latency leaves no meaningful window), but very real
// over an actual network link.
export function waitForDrain(dc: DataChannel, thresholdBytes = 0): Promise<void> {
  return new Promise((resolve) => {
    dc.setBufferedAmountLowThreshold(thresholdBytes);
    const check = () => {
      if (dc.bufferedAmount() <= thresholdBytes) resolve();
    };
    dc.onBufferedAmountLow(check);
    // Catch up in case it had already drained below the threshold before
    // this listener was attached (same reasoning as the other waitFor*
    // helpers above - the event only fires on the *next* transition).
    check();
  });
}

function waitForGathering(pc: nodeDataChannel.PeerConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    const checkComplete = (state: string) => {
      if (state !== 'complete') return;
      const desc = pc.localDescription();
      if (desc) resolve(desc.sdp);
      else reject(new Error('No local description after gathering'));
    };

    // Attach the listener before anything that could kick off gathering
    // (setLocalDescription/setRemoteDescription). Gathering can complete
    // synchronously on a fast network, and the native side only notifies on
    // the *next* state transition - if we registered the listener after
    // gathering already finished, that transition would never come and this
    // would hang forever. Re-check the current state immediately after
    // attaching to close that race entirely.
    pc.onGatheringStateChange(checkComplete);
    checkComplete(pc.gatheringState());
  });
}

export async function createOffer(): Promise<{ pc: nodeDataChannel.PeerConnection; dc: DataChannel; offerSdp: string }> {
  const pc = new nodeDataChannel.PeerConnection('sender', rtcConfig);
  const gathering = waitForGathering(pc);
  // createDataChannel() triggers negotiation and generates the local offer
  // description automatically - no explicit setLocalDescription() call needed.
  const dc = pc.createDataChannel('file-transfer');

  const offerSdp = await gathering;

  return { pc, dc, offerSdp };
}

export async function createAnswer(offerSdp: string): Promise<{ pc: nodeDataChannel.PeerConnection; dc: Promise<DataChannel>; answerSdp: string }> {
  const pc = new nodeDataChannel.PeerConnection('receiver', rtcConfig);
  const gathering = waitForGathering(pc);

  // The remote peer only opens its data channel in-band once the DTLS/SCTP
  // connection is actually up, which can't happen until the sender has
  // applied *our* answer. If we awaited this here, we could never return the
  // answer for the caller to send back - both sides would be stuck waiting
  // on each other. So hand back a promise instead and let the caller await
  // it only after the answer has gone out.
  const dc = new Promise<DataChannel>((resolve) => {
    pc.onDataChannel((channel) => resolve(channel));
  });

  // setRemoteDescription() reciprocates and generates the local answer
  // description automatically. Calling setLocalDescription('answer')
  // explicitly here throws, since the signaling state is already 'stable'
  // by the time this returns.
  pc.setRemoteDescription(offerSdp, 'offer');
  const answerSdp = await gathering;

  return { pc, dc, answerSdp };
}
