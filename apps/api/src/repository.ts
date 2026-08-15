import { randomUUID } from "node:crypto";
import pg from "pg";
import type { BusinessConfig, Call, OutboundMessage, Repository, Session, TranscriptMessage, User } from "./domain.js";

export class MemoryRepository implements Repository {
  users = new Map<string, User>();
  sessions = new Map<string, Session>();
  calls = new Map<string, Call>();
  messages = new Map<string, TranscriptMessage[]>();
  processed = new Set<string>();
  outbound = new Map<string, OutboundMessage>();
  whatsapp = new Map<string, string>();
  audits: unknown[] = [];
  business: BusinessConfig = { name: "Cooper2Talk Demo", greeting: "Thank you for calling. How can I help?", timezone: "America/Toronto", businessHours: {}, systemPrompt: "Be concise, warm, and helpful.", voice: "ira" };
  async init() {}
  async getUserById(id: string) { return this.users.get(id); }
  async getUserByEmail(email: string) { return [...this.users.values()].find((u) => u.email === email.toLowerCase()); }
  async createUser(user: User) { this.users.set(user.id, user); }
  async listUsers() { return [...this.users.values()].map((user) => structuredClone(user)); }
  async createSession(session: Session) { this.sessions.set(session.id, session); }
  async getSession(id: string) { const s = this.sessions.get(id); return s && Date.parse(s.expiresAt) > Date.now() ? s : undefined; }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async saveCall(call: Call) { this.calls.set(call.id, structuredClone(call)); }
  async getCall(id: string) { const call = this.calls.get(id); return call && structuredClone(call); }
  async getCallByRunId(runId: string) { return [...this.calls.values()].find((c) => c.dograhRunId === runId); }
  async listCalls() { return [...this.calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  async addTranscript(message: TranscriptMessage) { this.messages.set(message.callId, [...(this.messages.get(message.callId) ?? []), structuredClone(message)]); }
  async listTranscript(callId: string) { return structuredClone(this.messages.get(callId) ?? []); }
  async markEventProcessed(id: string) { if (this.processed.has(id)) return false; this.processed.add(id); return true; }
  async queueOutbound(message: OutboundMessage) { this.outbound.set(message.id, structuredClone(message)); }
  async claimOutbound(now: string) { return [...this.outbound.values()].find((m) => !m.deliveredAt && !m.failedAt && m.availableAt <= now); }
  async saveOutbound(message: OutboundMessage) { this.outbound.set(message.id, structuredClone(message)); }
  async findCallByWhatsAppMessage(messageId: string) { const id = this.whatsapp.get(messageId); return id ? this.getCall(id) : undefined; }
  async mapWhatsAppMessage(messageId: string, callId: string) { this.whatsapp.set(messageId, callId); }
  async writeAudit(action: string, actorId: string | undefined, callId: string | undefined, details: Record<string, unknown>) { this.audits.push({ id: randomUUID(), action, actorId, callId, details }); }
  async purgeTranscripts(before: string) { let removed = 0; for (const [callId, items] of this.messages) { const keep = items.filter((item) => item.occurredAt >= before); removed += items.length - keep.length; this.messages.set(callId, keep); } return removed; }
  async getBusinessConfig() { return structuredClone(this.business); }
  async saveBusinessConfig(config: BusinessConfig) { this.business = structuredClone(config); }
}

export class PostgresRepository implements Repository {
  private pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url }); }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, role text NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token text NOT NULL, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id uuid PRIMARY KEY, dograh_run_id text UNIQUE NOT NULL, provider text NOT NULL DEFAULT 'twilio', provider_call_id text, call_leg_id text, call_session_id text, twilio_call_sid text, stream_sid text, from_number text, to_number text, forwarded_from text, original_caller text, status text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, ai_state text, cost_usd numeric, metadata jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS transcript_messages (id uuid PRIMARY KEY, call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE, speaker text NOT NULL, text text NOT NULL, source text NOT NULL, occurred_at timestamptz NOT NULL, interrupted boolean NOT NULL DEFAULT false);
      CREATE TABLE IF NOT EXISTS processed_events (id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS outbound_messages (id uuid PRIMARY KEY, call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE, kind text NOT NULL, body jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL, external_id text, delivered_at timestamptz, failed_at timestamptz);
      CREATE TABLE IF NOT EXISTS whatsapp_message_map (message_id text PRIMARY KEY, call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS audit_events (id uuid PRIMARY KEY, action text NOT NULL, actor_id uuid, call_id uuid, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS business_config (id boolean PRIMARY KEY DEFAULT true CHECK(id), value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS idx_transcript_call ON transcript_messages(call_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_ready ON outbound_messages(available_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider text;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_call_id text;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_leg_id text;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_session_id text;
      UPDATE calls SET provider = 'twilio' WHERE provider IS NULL;
      ALTER TABLE calls ALTER COLUMN provider SET DEFAULT 'twilio';
    `);
  }
  private toUser(row: any): User { return { id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role, createdAt: row.created_at.toISOString() }; }
  private toCall(row: any): Call { const provider = row.provider === "telnyx" ? "telnyx" : "twilio"; const providerCallId = row.provider_call_id ?? row.twilio_call_sid ?? undefined; return { id: row.id, dograhRunId: row.dograh_run_id, provider, providerCallId, callLegId: row.call_leg_id ?? undefined, callSessionId: row.call_session_id ?? undefined, twilioCallSid: row.twilio_call_sid ?? undefined, streamSid: row.stream_sid ?? undefined, fromNumber: row.from_number ?? undefined, toNumber: row.to_number ?? undefined, forwardedFrom: row.forwarded_from ?? undefined, originalCaller: row.original_caller ?? undefined, status: row.status, startedAt: row.started_at.toISOString(), endedAt: row.ended_at?.toISOString(), aiState: row.ai_state ?? undefined, costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd), metadata: row.metadata ?? {} }; }
  async getUserById(id: string) { const q = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]); return q.rows[0] && this.toUser(q.rows[0]); }
  async getUserByEmail(email: string) { const q = await this.pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]); return q.rows[0] && this.toUser(q.rows[0]); }
  async createUser(user: User) { await this.pool.query("INSERT INTO users VALUES ($1,$2,$3,$4,$5)", [user.id, user.email, user.passwordHash, user.role, user.createdAt]); }
  async listUsers() { const q = await this.pool.query("SELECT * FROM users ORDER BY created_at"); return q.rows.map((row) => this.toUser(row)); }
  async createSession(s: Session) { await this.pool.query("INSERT INTO sessions VALUES ($1,$2,$3,$4)", [s.id, s.userId, s.csrfToken, s.expiresAt]); }
  async getSession(id: string) { const q = await this.pool.query("SELECT * FROM sessions WHERE id=$1 AND expires_at > now()", [id]); return q.rows[0] && { id: q.rows[0].id, userId: q.rows[0].user_id, csrfToken: q.rows[0].csrf_token, expiresAt: q.rows[0].expires_at.toISOString() }; }
  async deleteSession(id: string) { await this.pool.query("DELETE FROM sessions WHERE id=$1", [id]); }
  async saveCall(c: Call) { await this.pool.query(`INSERT INTO calls (id,dograh_run_id,provider,provider_call_id,call_leg_id,call_session_id,twilio_call_sid,stream_sid,from_number,to_number,forwarded_from,original_caller,status,started_at,ended_at,ai_state,cost_usd,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (dograh_run_id) DO UPDATE SET provider=excluded.provider,provider_call_id=excluded.provider_call_id,call_leg_id=excluded.call_leg_id,call_session_id=excluded.call_session_id,twilio_call_sid=excluded.twilio_call_sid,stream_sid=excluded.stream_sid,from_number=excluded.from_number,to_number=excluded.to_number,forwarded_from=excluded.forwarded_from,original_caller=excluded.original_caller,status=excluded.status,ended_at=excluded.ended_at,ai_state=excluded.ai_state,cost_usd=excluded.cost_usd,metadata=excluded.metadata`, [c.id,c.dograhRunId,c.provider,c.providerCallId,c.callLegId,c.callSessionId,c.twilioCallSid,c.streamSid,c.fromNumber,c.toNumber,c.forwardedFrom,c.originalCaller,c.status,c.startedAt,c.endedAt,c.aiState,c.costUsd,JSON.stringify(c.metadata)]); }
  async getCall(id: string) { const q=await this.pool.query("SELECT * FROM calls WHERE id=$1",[id]); return q.rows[0]&&this.toCall(q.rows[0]); }
  async getCallByRunId(id: string) { const q=await this.pool.query("SELECT * FROM calls WHERE dograh_run_id=$1",[id]); return q.rows[0]&&this.toCall(q.rows[0]); }
  async listCalls() { const q=await this.pool.query("SELECT * FROM calls ORDER BY started_at DESC"); return q.rows.map((r)=>this.toCall(r)); }
  async addTranscript(m: TranscriptMessage) { await this.pool.query("INSERT INTO transcript_messages VALUES ($1,$2,$3,$4,$5,$6,$7)",[m.id,m.callId,m.speaker,m.text,m.source,m.occurredAt,Boolean(m.interrupted)]); }
  async listTranscript(callId: string) { const q=await this.pool.query("SELECT * FROM transcript_messages WHERE call_id=$1 ORDER BY occurred_at",[callId]); return q.rows.map((r)=>({id:r.id,callId:r.call_id,speaker:r.speaker,text:r.text,source:r.source,occurredAt:r.occurred_at.toISOString(),interrupted:r.interrupted})); }
  async markEventProcessed(id: string) { const q=await this.pool.query("INSERT INTO processed_events(id) VALUES($1) ON CONFLICT DO NOTHING",[id]); return q.rowCount === 1; }
  async queueOutbound(m: OutboundMessage) { await this.pool.query("INSERT INTO outbound_messages(id,call_id,kind,body,attempts,available_at) VALUES($1,$2,$3,$4,$5,$6)",[m.id,m.callId,m.kind,JSON.stringify(m.body),m.attempts,m.availableAt]); }
  async claimOutbound(now: string) { const q=await this.pool.query("SELECT * FROM outbound_messages WHERE delivered_at IS NULL AND failed_at IS NULL AND available_at <= $1 ORDER BY available_at LIMIT 1",[now]); const r=q.rows[0]; return r&&{id:r.id,callId:r.call_id,kind:r.kind,body:r.body,attempts:r.attempts,availableAt:r.available_at.toISOString(),externalId:r.external_id??undefined,deliveredAt:r.delivered_at?.toISOString(),failedAt:r.failed_at?.toISOString()}; }
  async saveOutbound(m: OutboundMessage) { await this.pool.query("UPDATE outbound_messages SET attempts=$2,available_at=$3,external_id=$4,delivered_at=$5,failed_at=$6 WHERE id=$1",[m.id,m.attempts,m.availableAt,m.externalId,m.deliveredAt,m.failedAt]); }
  async findCallByWhatsAppMessage(messageId: string) { const q=await this.pool.query("SELECT c.* FROM whatsapp_message_map w JOIN calls c ON c.id=w.call_id WHERE w.message_id=$1",[messageId]); return q.rows[0]&&this.toCall(q.rows[0]); }
  async mapWhatsAppMessage(messageId: string, callId: string) { await this.pool.query("INSERT INTO whatsapp_message_map VALUES($1,$2) ON CONFLICT DO NOTHING",[messageId,callId]); }
  async writeAudit(action: string, actorId: string | undefined, callId: string | undefined, details: Record<string, unknown>) { await this.pool.query("INSERT INTO audit_events VALUES($1,$2,$3,$4,$5,now())",[randomUUID(),action,actorId,callId,JSON.stringify(details)]); }
  async purgeTranscripts(before: string) { const q=await this.pool.query("DELETE FROM transcript_messages WHERE occurred_at < $1",[before]); return q.rowCount ?? 0; }
  async getBusinessConfig() { const q = await this.pool.query("SELECT value FROM business_config WHERE id=true"); return q.rows[0]?.value ?? { name: "Cooper2Talk Demo", greeting: "Thank you for calling. How can I help?", timezone: "America/Toronto", businessHours: {}, systemPrompt: "Be concise, warm, and helpful.", voice: "ira" }; }
  async saveBusinessConfig(config: BusinessConfig) { await this.pool.query("INSERT INTO business_config(id,value) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=now()", [JSON.stringify(config)]); }
}
