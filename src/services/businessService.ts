import type { VideoChannel } from "../domain/mediaTypes";

export type BusinessCallMode = "watch" | "interactive";

export interface BusinessCallSession {
  id: string;
  businessUrl: string;
  callId: string;
  roomId: string;
  roomCode: string;
  livekitUrl: string;
  token: string;
  mode: BusinessCallMode;
  defaultChannelId?: string;
  defaultTrackName?: string;
  message: string;
}

interface CreateDesktopCallSessionOptions {
  businessUrl: string;
  defaultChannel?: VideoChannel;
  mode: BusinessCallMode;
}

export async function createDesktopCallSession({
  businessUrl,
  defaultChannel,
  mode,
}: CreateDesktopCallSessionOptions): Promise<BusinessCallSession> {
  const normalizedBusinessUrl = normalizeBaseUrl(businessUrl);
  const stamp = compactTimestamp();
  const defaultChannelId = defaultChannel?.id ?? "field-camera";

  const orEndpoint = await postJson(
    `${normalizedBusinessUrl}/api/endpoints/register`,
    {
      id: `or-desktop-${stamp}`,
      clientType: "or-windows",
      displayName: "手术室端",
      tags: ["or-agent", "desktop-call-poc"],
    },
  );

  const teachingEndpoint = await postJson(
    `${normalizedBusinessUrl}/api/endpoints/register`,
    {
      id: `teaching-desktop-${stamp}`,
      clientType: "teaching-windows",
      displayName: "示教室端",
      tags: ["desktop-client", "desktop-call-poc"],
    },
  );

  const call = await postJson(
    `${normalizedBusinessUrl}/api/calls`,
    {
      callerEndpointId: teachingEndpoint.endpoint.id,
      targetEndpointId: orEndpoint.endpoint.id,
      requestedMode: mode,
    },
    201,
  );

  const accepted = await postJson(
    `${normalizedBusinessUrl}/api/calls/${call.call.id}/accept`,
    {
      mode,
      roomCode: `ST-DESK-${stamp.slice(0, 8)}-${stamp.slice(8)}`,
      defaultChannelId,
      channels: [
        {
          id: defaultChannelId,
          displayName: defaultChannel?.displayName ?? "术野摄像机",
          enabled: true,
          health: defaultChannel?.healthy === false ? "unknown" : "healthy",
          localPrimary: true,
          remoteDefault: true,
          priority: defaultChannel?.priority ?? 10,
          trackName: defaultChannel?.trackName ?? `video:${defaultChannelId}`,
        },
      ],
      hostIdentity: `or-desktop-host-${stamp}`,
    },
  );

  const token = await postJson(
    `${normalizedBusinessUrl}/api/rooms/${accepted.room.roomId}/tokens`,
    {
      clientType: "teaching-windows",
      identity: `desktop-client-${mode}-${stamp}`,
      mode,
    },
  );

  return {
    id: `${accepted.call.id}:${token.metadata?.defaultTrackName ?? ""}`,
    businessUrl: normalizedBusinessUrl,
    callId: accepted.call.id,
    roomId: accepted.room.roomId,
    roomCode: accepted.room.roomCode,
    livekitUrl: token.livekitUrl,
    token: token.token,
    mode,
    defaultChannelId: token.metadata?.defaultChannelId,
    defaultTrackName: token.metadata?.defaultTrackName,
    message: `${accepted.call.status} / ${accepted.room.mediaPolicy.defaultSelectionReason}`,
  };
}

async function postJson(url: string, body: unknown, expectedStatus = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${url} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(
        payload,
      )}`,
    );
  }
  return payload;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function compactTimestamp() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}
