export type Role = "admin" | "supervisor" | "viewer";
export type CallStatus = "active" | "completed" | "failed" | "transferred";
export type EventType = "call.started" | "transcript.final" | "call.interrupted" | "call.ended";
export type Speaker = "caller" | "assistant" | "operator";
export type TelephonyProvider = "twilio" | "telnyx";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: string;
}

/** Opaque, rotating credentials used by the native iPhone and Android app. */
export interface MobileSession {
  id: string;
  userId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface MobileDevicePreferences {
  callAlerts: boolean;
  summaryAlerts: boolean;
  deliveryAlerts: boolean;
}

export interface MobileDevice {
  id: string;
  userId: string;
  pushToken: string;
  platform: "ios" | "android";
  preferences: MobileDevicePreferences;
  createdAt: string;
  lastSeenAt: string;
}

export interface Call {
  id: string;
  dograhRunId: string;
  provider: TelephonyProvider;
  providerCallId?: string;
  callLegId?: string;
  callSessionId?: string;
  /** @deprecated Kept only to read existing Twilio call records. */
  twilioCallSid?: string;
  /** @deprecated Kept only to read existing Twilio call records. */
  streamSid?: string;
  fromNumber?: string;
  toNumber?: string;
  forwardedFrom?: string;
  originalCaller?: string;
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  aiState?: string;
  costUsd?: number;
  metadata: Record<string, unknown>;
}

export interface TranscriptMessage {
  id: string;
  callId: string;
  speaker: Speaker;
  text: string;
  source: "dograh" | "operator_console" | "operator_voice" | "whatsapp";
  occurredAt: string;
  interrupted?: boolean;
}

export interface OutboundMessage {
  id: string;
  callId: string;
  kind: "whatsapp_alert" | "whatsapp_summary" | "whatsapp_transcript" | "whatsapp_status" | "push_call_started" | "push_call_summary" | "push_delivery_failed";
  body: Record<string, unknown>;
  attempts: number;
  availableAt: string;
  externalId?: string;
  deliveredAt?: string;
  failedAt?: string;
  lastError?: string;
}

export interface BusinessConfig {
  name: string;
  greeting: string;
  timezone: string;
  businessHours: Record<string, string>;
  systemPrompt: string;
  voice: string;
  transferNumber?: string;
}

export interface DograhEvent {
  id: string;
  type: EventType;
  occurredAt: string;
  call: {
    dograhRunId: string;
    provider?: TelephonyProvider;
    providerCallId?: string;
    callLegId?: string;
    callSessionId?: string;
    twilioCallSid?: string;
    streamSid?: string;
    from?: string;
    to?: string;
    forwardedFrom?: string;
    originalCaller?: string;
    metadata?: Record<string, unknown>;
  };
  payload?: {
    speaker?: Speaker;
    text?: string;
    interrupted?: boolean;
    costUsd?: number;
  };
}

export interface Repository {
  init(): Promise<void>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  createUser(user: User): Promise<void>;
  createSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<void>;
  createMobileSession(session: MobileSession): Promise<void>;
  getMobileSessionByAccessHash(accessTokenHash: string): Promise<MobileSession | undefined>;
  getMobileSessionByRefreshHash(refreshTokenHash: string): Promise<MobileSession | undefined>;
  saveMobileSession(session: MobileSession): Promise<void>;
  deleteMobileSession(id: string): Promise<void>;
  upsertMobileDevice(device: MobileDevice): Promise<MobileDevice>;
  getMobileDevice(id: string): Promise<MobileDevice | undefined>;
  listMobileDevices(userId?: string): Promise<MobileDevice[]>;
  deleteMobileDevice(id: string, userId: string): Promise<void>;
  saveCall(call: Call): Promise<void>;
  getCall(id: string): Promise<Call | undefined>;
  getCallByRunId(runId: string): Promise<Call | undefined>;
  listCalls(): Promise<Call[]>;
  addTranscript(message: TranscriptMessage): Promise<void>;
  listTranscript(callId: string): Promise<TranscriptMessage[]>;
  markEventProcessed(id: string): Promise<boolean>;
  queueOutbound(message: OutboundMessage): Promise<void>;
  hasOutboundKind(callId: string, kind: OutboundMessage["kind"]): Promise<boolean>;
  listOutboundForCall(callId: string): Promise<OutboundMessage[]>;
  claimOutbound(now: string): Promise<OutboundMessage | undefined>;
  saveOutbound(message: OutboundMessage): Promise<void>;
  findCallByWhatsAppMessage(messageId: string): Promise<Call | undefined>;
  mapWhatsAppMessage(messageId: string, callId: string): Promise<void>;
  writeAudit(action: string, actorId: string | undefined, callId: string | undefined, details: Record<string, unknown>): Promise<void>;
  purgeTranscripts(before: string): Promise<number>;
  getBusinessConfig(): Promise<BusinessConfig>;
  saveBusinessConfig(config: BusinessConfig): Promise<void>;
}
