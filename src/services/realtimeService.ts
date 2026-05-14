import type { RecentConnection, RoomSession } from "../domain/types";

export function createLocalRoom(): RoomSession {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const now = new Date().toISOString();

  return {
    roomCode: `ST-${code}`,
    status: "created",
    createdAt: now,
    updatedAt: now,
    message: "本地房间已创建；TODO: 接入 LiveKit 房间创建与 token 签发。",
  };
}

export function markCalling(session: RoomSession): RoomSession {
  return {
    ...session,
    status: "calling",
    updatedAt: new Date().toISOString(),
    message: "呼叫请求已进入本地状态；TODO: 接入接收端信令通知。",
  };
}

export function createRecentConnection(
  endpoint: string,
  roomCode: string,
): RecentConnection {
  const safeEndpoint = endpoint.trim();
  const safeRoomCode = roomCode.trim();

  return {
    id: crypto.randomUUID(),
    label: safeRoomCode || safeEndpoint || "未命名连接",
    endpoint: safeEndpoint,
    roomCode: safeRoomCode,
    lastConnectedAt: new Date().toISOString(),
  };
}
