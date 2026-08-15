import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Call, DograhEvent, OutboundMessage, Repository, TranscriptMessage } from "./domain.js";
import { chooseOriginalCaller, normalizeCanadianNumber } from "./phone.js";

export class DograhClient {
  constructor(private readonly config: Config) {}
  async inject(call: Call, text: string, instructionId: string = randomUUID()) {
    if (!this.config.DOGRAH_BASE_URL || !this.config.DOGRAH_API_KEY) return { accepted: true, instructionId, simulated: true };
    const response = await fetch(`${this.config.DOGRAH_BASE_URL}/api/v1/cooper/calls/${encodeURIComponent(call.dograhRunId)}/operator-instructions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.config.DOGRAH_API_KEY}`, "x-cooper-instruction-secret": this.config.DOGRAH_EVENT_SECRET, "idempotency-key": instructionId }, body: JSON.stringify({ instructionId, text, source: "cooper2talk" }) });
    if (!response.ok) throw new Error(`Dograh injection failed (${response.status})`);
    return { accepted: true, instructionId, simulated: false };
  }
}

export class TwilioClient {
  constructor(private readonly config: Config) {}
  private enabled() { return Boolean(this.config.TWILIO_ACCOUNT_SID && this.config.TWILIO_AUTH_TOKEN); }
  private auth() { return `Basic ${Buffer.from(`${this.config.TWILIO_ACCOUNT_SID}:${this.config.TWILIO_AUTH_TOKEN}`).toString("base64")}`; }
  async end(call: Call) {
    const callSid = call.providerCallId ?? call.twilioCallSid;
    if (!callSid) throw new Error("Call does not have a Twilio Call SID");
    if (!this.enabled()) return { simulated: true };
    const body = new URLSearchParams({ Status: "completed" });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.config.TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(callSid)}.json`, { method: "POST", headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw new Error(`Twilio end failed (${response.status})`);
    return { simulated: false };
  }
  async transfer(call: Call, destination: string) {
    const callSid = call.providerCallId ?? call.twilioCallSid;
    if (!callSid) throw new Error("Call does not have a Twilio Call SID");
    const normalized = normalizeCanadianNumber(destination);
    if (!normalized) throw new Error("Transfer destination must be an E.164 North American number");
    if (!this.enabled()) return { simulated: true, destination: normalized };
    const twiml = `<Response><Dial><Number>${normalized}</Number></Dial></Response>`;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.config.TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(callSid)}.json`, { method: "POST", headers: { authorization: this.auth(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Twiml: twiml }) });
    if (!response.ok) throw new Error(`Twilio transfer failed (${response.status})`);
    return { simulated: false, destination: normalized };
  }
}

export class TelnyxClient {
  constructor(private readonly config: Config) {}
  private enabled() { return Boolean(this.config.TELNYX_API_KEY); }
  private headers() { return { authorization: `Bearer ${this.config.TELNYX_API_KEY}`, "content-type": "application/json" }; }
  private callControlId(call: Call) {
    if (!call.providerCallId) throw new Error("Call does not have a Telnyx Call Control ID");
    return call.providerCallId;
  }
  async end(call: Call) {
    const callControlId = this.callControlId(call);
    if (!this.enabled()) return { simulated: true, provider: "telnyx" as const };
    const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`, { method: "POST", headers: this.headers(), body: JSON.stringify({ command_id: randomUUID() }) });
    if (!response.ok) throw new Error(`Telnyx hangup failed (${response.status})`);
    return { simulated: false, provider: "telnyx" as const };
  }
  async transfer(call: Call, destination: string) {
    const callControlId = this.callControlId(call);
    const normalized = normalizeCanadianNumber(destination);
    if (!normalized) throw new Error("Transfer destination must be an E.164 North American number");
    if (!this.enabled()) return { simulated: true, provider: "telnyx" as const, destination: normalized };
    const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, { method: "POST", headers: this.headers(), body: JSON.stringify({ to: normalized, command_id: randomUUID() }) });
    if (!response.ok) throw new Error(`Telnyx transfer failed (${response.status})`);
    return { simulated: false, provider: "telnyx" as const, destination: normalized };
  }
}

export class TelephonyClient {
  private readonly twilio: TwilioClient;
  private readonly telnyx: TelnyxClient;
  constructor(config: Config) { this.twilio = new TwilioClient(config); this.telnyx = new TelnyxClient(config); }
  end(call: Call) { return call.provider === "telnyx" ? this.telnyx.end(call) : this.twilio.end(call); }
  transfer(call: Call, destination: string) { return call.provider === "telnyx" ? this.telnyx.transfer(call, destination) : this.twilio.transfer(call, destination); }
}

export class WhatsAppClient {
  constructor(private readonly config: Config) {}
  async send(body: Record<string, unknown>) {
    if (!this.config.WHATSAPP_ACCESS_TOKEN || !this.config.WHATSAPP_PHONE_NUMBER_ID) return { externalId: `sim-${randomUUID()}` };
    const response = await fetch(`https://graph.facebook.com/v22.0/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: "POST", headers: { authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`WhatsApp send failed (${response.status})`);
    const json = await response.json() as { messages?: Array<{ id: string }> };
    return { externalId: json.messages?.[0]?.id ?? `unknown-${randomUUID()}` };
  }
  alertBody(to: string, call: Call) { return { messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "template", template: { name: this.config.WHATSAPP_ALERT_TEMPLATE, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: call.id }, { type: "text", text: call.originalCaller ?? "unknown caller" }] }] } }; }
  textBody(to: string, text: string) { return { messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "text", text: { body: text } }; }
}

export type Broadcast = (event: string, payload: unknown) => void;
export class CallService {
  constructor(private readonly repo: Repository, private readonly config: Config, private readonly broadcast: Broadcast) {}
  async ingest(event: DograhEvent) {
    if (!(await this.repo.markEventProcessed(event.id))) return { duplicate: true };
    const browserTest = event.call.metadata?.browserTest === true;
    let call = await this.repo.getCallByRunId(event.call.dograhRunId);
    if (!call) {
      const provider = event.call.provider ?? "twilio";
      const providerCallId = event.call.providerCallId ?? event.call.twilioCallSid;
      call = { id: randomUUID(), dograhRunId: event.call.dograhRunId, provider, providerCallId, callLegId: event.call.callLegId, callSessionId: event.call.callSessionId, twilioCallSid: provider === "twilio" ? providerCallId : undefined, streamSid: event.call.streamSid, fromNumber: normalizeCanadianNumber(event.call.from), toNumber: normalizeCanadianNumber(event.call.to), forwardedFrom: normalizeCanadianNumber(event.call.forwardedFrom), originalCaller: chooseOriginalCaller(event.call), status: "active", startedAt: event.occurredAt, aiState: "listening", metadata: event.call.metadata ?? {} };
    } else {
      call.provider = event.call.provider ?? call.provider;
      call.providerCallId = event.call.providerCallId ?? event.call.twilioCallSid ?? call.providerCallId;
      call.callLegId = event.call.callLegId ?? call.callLegId;
      call.callSessionId = event.call.callSessionId ?? call.callSessionId;
    }
    if (event.type === "call.ended") { call.status = "completed"; call.endedAt = event.occurredAt; call.costUsd = event.payload?.costUsd; call.aiState = "ended"; }
    if (event.type === "call.interrupted") call.aiState = "interrupted";
    await this.repo.saveCall(call);
    if (event.type === "call.started") {
      this.broadcast("call.started", call);
      if (!browserTest) for (const operator of this.config.operatorNumbers) await this.repo.queueOutbound({ id: randomUUID(), callId: call.id, kind: "whatsapp_alert", body: { operator, call }, attempts: 0, availableAt: new Date().toISOString() });
    }
    if (event.type === "transcript.final" && event.payload?.speaker && event.payload.text) {
      const message: TranscriptMessage = { id: randomUUID(), callId: call.id, speaker: event.payload.speaker, text: event.payload.text, source: "dograh", occurredAt: event.occurredAt, interrupted: event.payload.interrupted };
      await this.repo.addTranscript(message);
      this.broadcast("transcript.message", message);
      if (!browserTest) for (const operator of this.config.operatorNumbers) await this.repo.queueOutbound({ id: randomUUID(), callId: call.id, kind: "whatsapp_transcript", body: { operator, text: `${message.speaker === "caller" ? "Caller" : "AI"}: ${message.text}` }, attempts: 0, availableAt: new Date().toISOString() });
    }
    this.broadcast("call.updated", call);
    return { duplicate: false, call };
  }
  async activeCalls() { return (await this.repo.listCalls()).filter((call) => call.status === "active"); }
}

export class OutboxWorker {
  constructor(private readonly repo: Repository, private readonly whatsapp: WhatsAppClient) {}
  async processOne() {
    const message = await this.repo.claimOutbound(new Date().toISOString());
    if (!message) return false;
    try {
      const body = message.kind === "whatsapp_alert" ? this.whatsapp.alertBody((message.body as any).operator, (message.body as any).call) : this.whatsapp.textBody((message.body as any).operator, (message.body as any).text);
      const result = await this.whatsapp.send(body);
      message.externalId = result.externalId;
      message.deliveredAt = new Date().toISOString();
      await this.repo.saveOutbound(message);
      await this.repo.mapWhatsAppMessage(result.externalId, message.callId);
    } catch {
      message.attempts += 1;
      if (message.attempts >= 5) message.failedAt = new Date().toISOString();
      else message.availableAt = new Date(Date.now() + 1000 * 2 ** message.attempts).toISOString();
      await this.repo.saveOutbound(message);
    }
    return true;
  }
}

export function stableInstructionId(messageId: string) { return createHash("sha256").update(messageId).digest("hex"); }
