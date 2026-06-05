import type { VideoChannel } from "./mediaTypes";

export type ClientType =
  | "or-windows"
  | "teaching-windows"
  | "tablet-client"
  | "web-observer";

export type RoomMode = "watch" | "interactive" | "conference";

export type ParticipantRole =
  | "or-host"
  | "teacher"
  | "tablet"
  | "web-observer"
  | "recorder"
  | "service";

export interface AcceptedCallMediaPolicy {
  defaultChannelId?: string;
  defaultTrackName?: string;
  mode: RoomMode;
  allowedChannelIds: string[];
  publishOtherChannelsOnDemand: boolean;
}

export interface ParticipantLimits {
  maxInteractiveParticipants: number;
  maxTabletClients: number;
  maxWebObservers: number;
}

export interface RoomParticipantPolicy {
  identity: string;
  role: ParticipantRole;
  clientType: ClientType;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
}

export interface TeachingRoomPolicy {
  roomId: string;
  roomCode: string;
  mode: RoomMode;
  mediaPolicy: AcceptedCallMediaPolicy;
  limits: ParticipantLimits;
  channels: VideoChannel[];
  createdAt: string;
  updatedAt?: string;
}

export type CallStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "ended";

export interface TeachingCall {
  id: string;
  roomId?: string;
  callerEndpointId: string;
  targetEndpointId: string;
  requestedMode: RoomMode;
  acceptedMode?: RoomMode;
  status: CallStatus;
  mediaPolicy?: AcceptedCallMediaPolicy;
  createdAt: string;
  updatedAt?: string;
}

