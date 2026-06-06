import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import "./styles.css";

interface ObserverTokenResponse {
  token: string;
  tokenType: string;
  livekitUrl: string;
  grants: {
    roomJoin: boolean;
    canSubscribe: boolean;
    canPublish: boolean;
    canPublishData: boolean;
  };
  room: {
    roomId: string;
    roomCode: string;
    mediaPolicy: {
      defaultChannelId: string;
      defaultTrackName: string;
      allowedChannelIds: string[];
    };
  };
}

const form = mustGet<HTMLFormElement>("observer-form");
const serviceUrlInput = mustGet<HTMLInputElement>("service-url");
const roomCodeInput = mustGet<HTMLInputElement>("room-code");
const displayNameInput = mustGet<HTMLInputElement>("display-name");
const connectButton = mustGet<HTMLButtonElement>("connect-button");
const disconnectButton = mustGet<HTMLButtonElement>("disconnect-button");
const statusPill = mustGet<HTMLElement>("status-pill");
const statusBox = mustGet<HTMLElement>("observer-status");
const videoHost = mustGet<HTMLElement>("video-host");
const audioHost = mustGet<HTMLElement>("audio-host");
const trackList = mustGet<HTMLElement>("track-list");
const publishPolicy = mustGet<HTMLElement>("publish-policy");
const defaultTrack = mustGet<HTMLElement>("default-track");

const attachedTracks = new Map<string, { element: HTMLMediaElement; track: RemoteTrack }>();

let livekitRoom: Room | null = null;
let preferredTrackName = "";
let mountedVideoKey = "";

serviceUrlInput.value = defaultServiceUrl(serviceUrlInput.value);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void enterObserverRoom();
});

disconnectButton.addEventListener("click", () => {
  void disconnectRoom("已退出收看。");
});

async function enterObserverRoom() {
  await disconnectRoom();
  setBusy(true);
  setStatus("连接中", "正在请求收看权限。", "pending");

  try {
    const tokenResponse = await requestObserverToken();
    assertWatchOnly(tokenResponse);

    preferredTrackName = tokenResponse.room.mediaPolicy.defaultTrackName;
    publishPolicy.textContent = "禁止";
    defaultTrack.textContent = preferredTrackName || tokenResponse.room.mediaPolicy.defaultChannelId;

    if (tokenResponse.tokenType === "mock") {
      setStatus("已授权", "已获得只读 mock token；真实 LiveKit JWT 接入后可继续订阅媒体。", "ok");
      return;
    }

    const room = new Room({
      adaptiveStream: true,
      dynacast: false,
    });
    livekitRoom = room;

    room
      .on(RoomEvent.Connected, () => {
        setStatus("收看中", "已连接 LiveKit room。", "ok");
      })
      .on(RoomEvent.Reconnecting, () => {
        setStatus("重连中", "LiveKit 正在重连。", "pending");
      })
      .on(RoomEvent.Reconnected, () => {
        setStatus("收看中", "LiveKit 已重连。", "ok");
      })
      .on(RoomEvent.Disconnected, () => {
        setStatus("已断开", "LiveKit room 已断开。", "idle");
        resetMedia();
      })
      .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

    setStatus("连接中", "正在连接 LiveKit room。", "pending");
    await room.connect(tokenResponse.livekitUrl, tokenResponse.token);
  } catch (error) {
    setStatus("错误", error instanceof Error ? error.message : "手机收看连接失败。", "error");
    await disconnectRoom();
  } finally {
    setBusy(false);
  }
}

async function requestObserverToken(): Promise<ObserverTokenResponse> {
  const serviceUrl = normalizeBaseUrl(serviceUrlInput.value);
  const roomCode = roomCodeInput.value.trim();
  const displayName = displayNameInput.value.trim();

  if (!serviceUrl) {
    throw new Error("业务服务地址不能为空。");
  }
  if (!roomCode) {
    throw new Error("房间码不能为空。");
  }

  const response = await fetch(`${serviceUrl}/api/observer/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomCode,
      identity: displayName || `phone-${createId()}`,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "收看权限获取失败。");
  }
  return payload;
}

function assertWatchOnly(tokenResponse: ObserverTokenResponse) {
  const { grants } = tokenResponse;
  if (!grants.roomJoin || !grants.canSubscribe) {
    throw new Error("服务端未授予收看权限。");
  }
  if (grants.canPublish || grants.canPublishData) {
    throw new Error("服务端返回了发布权限，手机端拒绝连接。");
  }
}

function handleTrackSubscribed(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  const key = trackKey(publication, participant);
  addTrackRow(key, track, publication, participant);

  if (track.kind === Track.Kind.Video) {
    const shouldReplace =
      !mountedVideoKey || publication.trackName === preferredTrackName || key === preferredTrackName;
    if (shouldReplace) {
      mountVideo(key, track);
      mountedVideoKey = key;
    }
    return;
  }

  if (track.kind === Track.Kind.Audio) {
    mountAudio(key, track);
  }
}

function handleTrackUnsubscribed(
  _track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  const key = trackKey(publication, participant);
  detachTrack(key);
  removeTrackRow(key);
  if (mountedVideoKey === key) {
    mountedVideoKey = "";
    showEmptyVideo();
  }
}

function mountVideo(key: string, track: RemoteTrack) {
  if (mountedVideoKey && mountedVideoKey !== key) {
    detachTrack(mountedVideoKey);
  }
  const element = track.attach();
  element.autoplay = true;
  element.controls = false;
  element.className = "media-element";
  if (element instanceof HTMLVideoElement) {
    element.playsInline = true;
  }
  videoHost.replaceChildren(element);
  attachedTracks.set(key, { element, track });
}

function mountAudio(key: string, track: RemoteTrack) {
  if (attachedTracks.has(key)) return;
  const element = track.attach();
  element.autoplay = true;
  element.controls = false;
  element.className = "audio-element";
  audioHost.append(element);
  attachedTracks.set(key, { element, track });
}

function detachTrack(key: string) {
  const mounted = attachedTracks.get(key);
  if (!mounted) return;
  mounted.track.detach(mounted.element);
  mounted.element.remove();
  attachedTracks.delete(key);
}

async function disconnectRoom(message?: string) {
  const room = livekitRoom;
  livekitRoom = null;
  if (room) {
    await room.disconnect();
  }
  resetMedia();
  if (message) {
    setStatus("已断开", message, "idle");
  }
}

function resetMedia() {
  for (const key of [...attachedTracks.keys()]) {
    detachTrack(key);
  }
  trackList.replaceChildren();
  mountedVideoKey = "";
  showEmptyVideo();
}

function showEmptyVideo() {
  const empty = document.createElement("div");
  empty.className = "empty-video";
  empty.textContent = "远端默认画面";
  videoHost.replaceChildren(empty);
}

function addTrackRow(
  key: string,
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
) {
  if (trackList.querySelector(`[data-track-key="${key}"]`)) return;
  const row = document.createElement("div");
  row.className = "track-row";
  row.dataset.trackKey = key;
  row.innerHTML = `<strong>${escapeHtml(publication.trackName || publication.source || track.kind)}</strong><span>${escapeHtml(participant.identity)} · ${escapeHtml(track.kind)}</span>`;
  trackList.append(row);
}

function removeTrackRow(key: string) {
  trackList.querySelector(`[data-track-key="${key}"]`)?.remove();
}

function setBusy(isBusy: boolean) {
  connectButton.disabled = isBusy;
  disconnectButton.disabled = isBusy || !livekitRoom;
}

function setStatus(title: string, detail: string, tone: "idle" | "pending" | "ok" | "error") {
  statusPill.textContent = title;
  statusBox.className = `observer-status ${tone}`;
  statusBox.querySelector("p")!.textContent = detail;
}

function trackKey(publication: RemoteTrackPublication, participant: RemoteParticipant) {
  return `${participant.identity}:${publication.trackSid || publication.trackName || publication.source}`;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function defaultServiceUrl(currentValue: string) {
  const current = currentValue.trim();
  const host = window.location.hostname;
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "";
  if (!isLocalhost && (!current || current.includes("127.0.0.1") || current.includes("localhost"))) {
    return `${protocol}//${host}:4780`;
  }
  return current;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 10000)}`;
}

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}
