import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";

export type LiveKitPocMode = "watch" | "interactive";

export type LiveKitPocStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "error";

export interface LiveKitPocConnectOptions {
  serverUrl: string;
  token: string;
  mode: LiveKitPocMode;
  publishCamera: boolean;
  publishMicrophone: boolean;
  onStatus?: (status: LiveKitPocStatus, message?: string) => void;
  onRemoteTrack?: (trackInfo: LiveKitRemoteTrackInfo) => void;
  onRemoteTrackUnsubscribed?: (trackInfo: LiveKitRemoteTrackInfo) => void;
}

export interface LiveKitConnectionDraft {
  id: string;
  serverUrl: string;
  token: string;
  mode: LiveKitPocMode;
  publishCamera?: boolean;
  publishMicrophone?: boolean;
  roomCode?: string;
  defaultChannelId?: string;
  defaultTrackName?: string;
  source?: string;
}

export interface LiveKitRemoteTrackInfo {
  participantIdentity: string;
  trackSid?: string;
  trackName?: string;
  source?: string;
  kind: string;
  track: RemoteTrack;
}

export interface LiveKitPocSession {
  room: Room;
  disconnect: () => Promise<void>;
}

export async function connectLiveKitPoc({
  serverUrl,
  token,
  mode,
  publishCamera,
  publishMicrophone,
  onStatus,
  onRemoteTrack,
  onRemoteTrackUnsubscribed,
}: LiveKitPocConnectOptions): Promise<LiveKitPocSession> {
  const safeServerUrl = serverUrl.trim();
  const safeToken = token.trim();

  if (!safeServerUrl) {
    throw new Error("请填写 LiveKit server URL。");
  }

  if (!safeToken) {
    throw new Error("请填写短期 LiveKit token。不能使用 API secret。");
  }

  if (safeToken.startsWith("mock.")) {
    throw new Error("当前 token 是 server-poc mock token，不能连接真实 LiveKit。");
  }

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  room
    .on(RoomEvent.Connected, () => onStatus?.("connected", "已连接 LiveKit room。"))
    .on(RoomEvent.Reconnecting, () =>
      onStatus?.("connecting", "LiveKit 正在重连。"),
    )
    .on(RoomEvent.Reconnected, () =>
      onStatus?.("connected", "LiveKit 已重连。"),
    )
    .on(RoomEvent.Disconnected, () =>
      onStatus?.("disconnected", "已断开 LiveKit room。"),
    )
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      onRemoteTrack?.(toRemoteTrackInfo(track, publication, participant));
    })
    .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      onRemoteTrackUnsubscribed?.(
        toRemoteTrackInfo(track, publication, participant),
      );
    });

  onStatus?.("connecting", "正在连接 LiveKit room...");
  await room.connect(safeServerUrl, safeToken);

  if (mode === "interactive") {
    if (publishCamera) {
      await room.localParticipant.setCameraEnabled(true, {
        resolution: {
          width: 1280,
          height: 720,
          frameRate: 30,
        },
      });
    }

    if (publishMicrophone) {
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    }
  }

  if (mode === "watch" && (publishCamera || publishMicrophone)) {
    onStatus?.("connected", "仅收看模式已连接，本地音视频发布被禁止。");
  }

  return {
    room,
    disconnect: async () => {
      onStatus?.("disconnecting", "正在断开 LiveKit room...");
      await room.disconnect();
      onStatus?.("disconnected", "已断开 LiveKit room。");
    },
  };
}

function toRemoteTrackInfo(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
): LiveKitRemoteTrackInfo {
  return {
    participantIdentity: participant.identity,
    trackSid: publication.trackSid,
    trackName: publication.trackName,
    source: publication.source,
    kind: track.kind === Track.Kind.Video ? "video" : track.kind,
    track,
  };
}
