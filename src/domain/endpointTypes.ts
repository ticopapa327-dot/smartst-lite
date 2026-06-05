import type { ClientType } from "./roomTypes";

export type EndpointStatus = "online" | "offline" | "busy" | "error";

export interface ClientEndpoint {
  id: string;
  displayName: string;
  clientType: ClientType;
  ipAddress?: string;
  status: EndpointStatus;
  appVersion?: string;
  lastSeenAt?: string;
}

export interface BusinessServiceConfig {
  baseUrl: string;
  websocketUrl?: string;
  endpointId?: string;
}

export interface LiveKitConnectionConfig {
  serverUrl: string;
  roomName: string;
  token: string;
  identity: string;
}

export interface WebObserverAccess {
  accessCode: string;
  roomCode: string;
  expiresAt: string;
  maxObservers: number;
}

