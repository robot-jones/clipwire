import nodeDataChannel, { type DataChannel } from 'node-datachannel';

export type { DataChannel };

const rtcConfig: nodeDataChannel.RtcConfig = {
  iceServers: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
  ],
};

function waitForGathering(pc: nodeDataChannel.PeerConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    pc.onGatheringStateChange((state) => {
      if (state === 'complete') {
        const desc = pc.localDescription();
        if (desc) resolve(desc.sdp);
        else reject(new Error('No local description after gathering'));
      }
    });
  });
}

export async function createOffer(): Promise<{ pc: nodeDataChannel.PeerConnection; dc: DataChannel; offerSdp: string }> {
  const pc = new nodeDataChannel.PeerConnection('sender', rtcConfig);
  const dc = pc.createDataChannel('file-transfer');

  pc.setLocalDescription('offer');
  const offerSdp = await waitForGathering(pc);

  return { pc, dc, offerSdp };
}

export async function createAnswer(offerSdp: string): Promise<{ pc: nodeDataChannel.PeerConnection; dc: DataChannel; answerSdp: string }> {
  const pc = new nodeDataChannel.PeerConnection('receiver', rtcConfig);
  let dc!: DataChannel;

  await new Promise<void>((resolve) => {
    pc.onDataChannel((channel) => {
      dc = channel;
      resolve();
    });
    pc.setRemoteDescription(offerSdp, 'offer');
  });

  pc.setLocalDescription('answer');
  const answerSdp = await waitForGathering(pc);

  return { pc, dc, answerSdp };
}
