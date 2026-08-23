import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Call, DograhEvent, OutboundMessage, Repository, TranscriptMessage } from "./domain.js";
import { chooseOriginalCaller, normalizeCanadianNumber } from "./phone.js";

export class DograhClient {
  constructor(private readonly config: Config) {}
  async inject(call: Call, text: string, instructionId: string = randomUUID()) {
    if (!this.config.DOGRAH_BASE_URL || !this.config.DOGRAH_EVENT_SECRET) return { accepted: true, instructionId, simulated: true };
    const headers: Record<string, string> = { "content-type": "application/json", "x-cooper-instruction-secret": this.config.DOGRAH_EVENT_SECRET, "idempotency-key": instructionId };
    if (this.config.DOGRAH_API_KEY) headers.authorization = `Bearer ${this.config.DOGRAH_API_KEY}`;
    const response = await fetch(`${this.config.DOGRAH_BASE_URL}/api/v1/cooper/calls/${encodeURIComponent(call.dograhRunId)}/operator-instructions`, { method: "POST", headers, body: JSON.stringify({ instructionId, text, source: "cooper2talk" }) });
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

export type SummaryLanguage = "english" | "hinglish";
export type CallSummary = { language: SummaryLanguage; update: string; urgency: string; source: "ai" | "fallback" };
export interface CallSummaryGenerator {
  generate(call: Call, transcript: TranscriptMessage[]): Promise<CallSummary>;
}

export class CallSummaryService implements CallSummaryGenerator {
  constructor(private readonly config: Config, private readonly request: typeof fetch = fetch) {}

  async generate(call: Call, transcript: TranscriptMessage[]): Promise<CallSummary> {
    const callerText = transcript.filter((message) => message.speaker === "caller").map((message) => message.text).join("\n");
    const fallback = fallbackSummary(callerText);
    if (!this.config.GROQ_API_KEY || !callerText.trim()) return fallback;

    const dialogue = transcript
      .filter((message) => message.speaker === "caller" || message.speaker === "assistant")
      .slice(-24)
      .map((message) => `${message.speaker === "caller" ? "Caller" : "Emma"}: ${message.text}`)
      .join("\n")
      .slice(-12000);
    try {
      const response = await this.request("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.GROQ_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          temperature: 0.1,
          max_tokens: 160,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Create a factual call-close WhatsApp summary from the transcript. Return JSON only: {\"language\":\"english|hinglish\",\"update\":\"...\",\"urgency\":\"...\"}. Determine language only from caller turns: use hinglish when the caller uses Hindi, Hinglish, or a mix; otherwise english. Hinglish must use Latin script, not Devanagari. Keep update under 360 characters. Preserve phone numbers, codes, and reference numbers as digits. Include only facts actually stated. Never promise a callback, action, availability, or urgency. Use urgency \"Not stated\" in English or \"Mention nahi hua\" in Hinglish unless urgency was explicitly stated."
            },
            { role: "user", content: dialogue }
          ]
        })
      });
      if (!response.ok) throw new Error(`Groq summary failed (${response.status})`);
      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq summary returned no content");
      const parsed = JSON.parse(stripCodeFence(content)) as Partial<CallSummary>;
      const language: SummaryLanguage = parsed.language === "hinglish" ? "hinglish" : parsed.language === "english" ? "english" : fallback.language;
      const update = cleanSummaryText(parsed.update);
      if (!update) throw new Error("Groq summary did not include an update");
      return {
        language,
        update,
        urgency: cleanSummaryText(parsed.urgency) || (language === "hinglish" ? "Mention nahi hua" : "Not stated"),
        source: "ai"
      };
    } catch {
      return fallback;
    }
  }
}

function stripCodeFence(value: string) {
  return value.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
}

function cleanSummaryText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 360) : "";
}

function fallbackSummary(callerText: string): CallSummary {
  const language = detectCallerLanguage(callerText);
  const lastCallerText = callerText.split(/\n+/).filter(Boolean).slice(-2).join(" ").replace(/\s+/g, " ").trim().slice(0, 360);
  const statedUrgency = /\b(urgent|urgency|asap|emergency|immediately|jaldi|zaroori|fauran)\b/i.test(callerText);
  return {
    language,
    update: lastCallerText || (language === "hinglish" ? "Caller ki transcript available nahi thi. Cooper2Talk mein full transcript dekhein." : "No caller transcript was available. Review the full transcript in Cooper2Talk."),
    urgency: statedUrgency ? (language === "hinglish" ? "Caller ne urgent bataya" : "Caller stated this is urgent") : (language === "hinglish" ? "Mention nahi hua" : "Not stated"),
    source: "fallback"
  };
}

function detectCallerLanguage(value: string): SummaryLanguage {
  if (/[\u0900-\u097f]/.test(value)) return "hinglish";
  return /\b(mujhe|main|mein|hai|hain|nahi|nahin|aap|aapka|aapki|ka|ki|ke|karna|karo|bata|jaldi|zaroori|kripya)\b/i.test(value) ? "hinglish" : "english";
}

function callDuration(call: Call) {
  if (!call.endedAt) return "Not available";
  const seconds = Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export class WhatsAppClient {
  constructor(private readonly config: Config) {}
  async send(body: Record<string, unknown>) {
    if (!this.config.WHATSAPP_ACCESS_TOKEN || !this.config.WHATSAPP_PHONE_NUMBER_ID) throw new Error("WhatsApp Cloud API sender credentials are not configured");
    const response = await fetch(`https://graph.facebook.com/v22.0/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: "POST", headers: { authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`WhatsApp send failed (${response.status})`);
    const json = await response.json() as { messages?: Array<{ id: string }> };
    return { externalId: json.messages?.[0]?.id ?? `unknown-${randomUUID()}` };
  }
  alertBody(to: string, call: Call, agentLabel: string) { return { messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "template", template: { name: this.config.WHATSAPP_ALERT_TEMPLATE, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: agentLabel }, { type: "text", text: call.toNumber ?? "unknown number" }, { type: "text", text: call.originalCaller ?? call.fromNumber ?? "unknown caller" }] }] } }; }
  summaryBody(to: string, call: Call, summary: CallSummary) {
    return {
      messaging_product: "whatsapp",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: this.config.WHATSAPP_SUMMARY_TEMPLATE,
        language: { code: "en_US" },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: call.originalCaller ?? call.fromNumber ?? "Unknown caller" },
            { type: "text", text: callDuration(call) },
            { type: "text", text: summary.update },
            { type: "text", text: summary.urgency }
          ]
        }]
      }
    };
  }
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
      const alertRoute = call.toNumber ? this.config.whatsappAlertRoutes.get(call.toNumber) : undefined;
      if (!browserTest && alertRoute) for (const operator of this.config.operatorNumbers) await this.repo.queueOutbound({ id: randomUUID(), callId: call.id, kind: "whatsapp_alert", body: { operator, call, agentLabel: alertRoute.agentLabel }, attempts: 0, availableAt: new Date().toISOString() });
    }
    if (event.type === "transcript.final" && event.payload?.speaker && event.payload.text) {
      const message: TranscriptMessage = { id: randomUUID(), callId: call.id, speaker: event.payload.speaker, text: event.payload.text, source: "dograh", occurredAt: event.occurredAt, interrupted: event.payload.interrupted };
      await this.repo.addTranscript(message);
      this.broadcast("transcript.message", message);
    }
    if (event.type === "call.ended") {
      const alertRoute = call.toNumber ? this.config.whatsappAlertRoutes.get(call.toNumber) : undefined;
      if (!browserTest && alertRoute?.callSummary && !(await this.repo.hasOutboundKind(call.id, "whatsapp_summary"))) {
        const availableAt = new Date(Date.now() + this.config.WHATSAPP_SUMMARY_DELAY_SECONDS * 1000).toISOString();
        const operator = [...this.config.operatorNumbers][0];
        if (operator) {
          await this.repo.queueOutbound({
            id: randomUUID(),
            callId: call.id,
            kind: "whatsapp_summary",
            body: { operator, agentLabel: alertRoute.agentLabel },
            attempts: 0,
            availableAt
          });
        }
      }
    }
    this.broadcast("call.updated", call);
    return { duplicate: false, call };
  }
  async activeCalls() { return (await this.repo.listCalls()).filter((call) => call.status === "active"); }
}

export class OutboxWorker {
  constructor(
    private readonly repo: Repository,
    private readonly whatsapp: WhatsAppClient,
    private readonly summaries: CallSummaryGenerator
  ) {}
  async processOne() {
    const message = await this.repo.claimOutbound(new Date().toISOString());
    if (!message) return false;
    try {
      let body: Record<string, unknown>;
      if (message.kind === "whatsapp_alert") {
        body = this.whatsapp.alertBody((message.body as any).operator, (message.body as any).call, (message.body as any).agentLabel);
      } else if (message.kind === "whatsapp_summary") {
        const call = await this.repo.getCall(message.callId);
        if (!call) throw new Error("Call no longer exists for WhatsApp summary");
        let summary = (message.body as any).summary as CallSummary | undefined;
        if (!summary) {
          summary = await this.summaries.generate(call, await this.repo.listTranscript(call.id));
          message.body = { ...message.body, summary };
          await this.repo.saveOutbound(message);
        }
        body = this.whatsapp.summaryBody((message.body as any).operator, call, summary);
      } else {
        throw new Error("Unsupported WhatsApp outbox message kind");
      }
      const result = await this.whatsapp.send(body);
      message.externalId = result.externalId;
      message.deliveredAt = new Date().toISOString();
      message.lastError = undefined;
      await this.repo.saveOutbound(message);
      await this.repo.mapWhatsAppMessage(result.externalId, message.callId);
    } catch (error) {
      message.attempts += 1;
      message.lastError = error instanceof Error ? error.message.slice(0, 500) : "WhatsApp delivery failed";
      if (message.attempts >= 5) message.failedAt = new Date().toISOString();
      else message.availableAt = new Date(Date.now() + 1000 * 2 ** message.attempts).toISOString();
      await this.repo.saveOutbound(message);
    }
    return true;
  }
}

export function stableInstructionId(messageId: string) { return createHash("sha256").update(messageId).digest("hex"); }
