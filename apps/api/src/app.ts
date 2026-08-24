import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import rawBody from "fastify-raw-body";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { validSignature } from "./crypto.js";
import type { BusinessConfig, Call, DograhEvent, Repository, Role, User } from "./domain.js";
import { normalizeCanadianNumber } from "./phone.js";
import { CallService, CallSummaryService, DeepgramVoiceInstructionTranscriber, DograhClient, type InstructionClient, OutboxWorker, stableInstructionId, TelephonyClient, type VoiceInstructionTranscriber, WhatsAppClient } from "./services.js";

declare module "fastify" { interface FastifyRequest { rawBody?: string | Buffer } }

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const injectionSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const transferSchema = z.object({ destination: z.string().min(7).max(32) });
const operatorSchema = z.object({ email: z.string().email(), password: z.string().min(12).max(128), role: z.enum(["admin", "supervisor", "viewer"]) });
const businessSchema = z.object({ name: z.string().trim().min(1).max(120), greeting: z.string().trim().min(1).max(1000), timezone: z.string().trim().min(1).max(100), businessHours: z.record(z.string().max(120)), systemPrompt: z.string().trim().min(1).max(12000), voice: z.string().trim().min(1).max(120), transferNumber: z.string().optional() });
const dograhEventSchema = z.object({
  id: z.string().min(1), type: z.enum(["call.started", "transcript.final", "call.interrupted", "call.ended"]), occurredAt: z.string().datetime(),
  call: z.object({ dograhRunId: z.string().min(1), provider: z.enum(["twilio", "telnyx"]).optional(), providerCallId: z.string().optional(), callLegId: z.string().optional(), callSessionId: z.string().optional(), twilioCallSid: z.string().optional(), streamSid: z.string().optional(), from: z.string().optional(), to: z.string().optional(), forwardedFrom: z.string().optional(), originalCaller: z.string().optional(), metadata: z.record(z.unknown()).optional() }),
  payload: z.object({ speaker: z.enum(["caller", "assistant", "operator"]).optional(), text: z.string().optional(), interrupted: z.boolean().optional(), costUsd: z.number().nonnegative().optional() }).optional()
});

type Principal = { user: User; sessionId: string; csrfToken: string };
type DependencyOverrides = { dograh?: InstructionClient; telephony?: TelephonyClient; whatsapp?: WhatsAppClient; transcriber?: VoiceInstructionTranscriber };
const MAX_VOICE_INSTRUCTION_BYTES = 10 * 1024 * 1024;
const supportedVoiceMimeTypes = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]);

export async function createApp(repo: Repository, config: Config, overrides: DependencyOverrides = {}) {
  const app = Fastify({ logger: config.NODE_ENV !== "test", trustProxy: config.NODE_ENV === "production" });
  const clients = {
    dograh: overrides.dograh ?? new DograhClient(config),
    telephony: overrides.telephony ?? new TelephonyClient(config),
    transcriber: overrides.transcriber ?? new DeepgramVoiceInstructionTranscriber(config),
    whatsapp: overrides.whatsapp ?? new WhatsAppClient(config)
  };
  const sockets = new Set<any>();
  const broadcast = (event: string, payload: unknown) => {
    const data = JSON.stringify({ event, payload });
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(data);
  };
  const callService = new CallService(repo, config, broadcast);
  const outbox = new OutboxWorker(repo, clients.whatsapp, new CallSummaryService(config));

  await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
  await app.register(websocket);
  await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
  app.addContentTypeParser(/^audio\/(webm|ogg|mp4|mpeg|wav)(?:;.*)?$/i, { parseAs: "buffer", bodyLimit: MAX_VOICE_INSTRUCTION_BYTES }, (_request, body, done) => done(null, body));
  await app.register(staticFiles, { root: path.resolve(process.cwd(), "apps/console/dist"), prefix: "/", wildcard: false, decorateReply: false });

  async function principal(request: FastifyRequest): Promise<Principal | undefined> {
    const sessionId = request.cookies.cooper_session;
    if (!sessionId) return undefined;
    const session = await repo.getSession(sessionId);
    if (!session) return undefined;
    const user = await repo.getUserById(session.userId);
    return user ? { user, sessionId, csrfToken: session.csrfToken } : undefined;
  }
  async function requireUser(request: FastifyRequest, roles?: Role[]) {
    const p = await principal(request);
    if (!p) fail(401, "Sign in required");
    if (roles && !roles.includes(p.user.role)) fail(403, "Insufficient role");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.url.startsWith("/api/") && request.headers["x-csrf-token"] !== p.csrfToken) fail(403, "Invalid CSRF token");
    return p;
  }
  async function getCall(callId: string) { const call = await repo.getCall(callId); if (!call) fail(404, "Call not found"); return call; }
  async function injectOperatorInstruction(call: Call, text: string, principal: Principal, source: "operator_console" | "operator_voice", auditAction: "call.inject" | "call.voice_inject") {
    const instructionId = randomUUID();
    const message = { id: randomUUID(), callId: call.id, speaker: "operator" as const, text, source, occurredAt: new Date().toISOString() };
    await repo.addTranscript(message);
    await repo.writeAudit(auditAction, principal.user.id, call.id, { instructionId });
    broadcast("transcript.message", message);
    try {
      const result = await clients.dograh.inject(call, text, instructionId);
      broadcast("injection.status", { callId: call.id, instructionId, status: "accepted", source });
      return { ...result, text };
    } catch (error) {
      broadcast("injection.status", { callId: call.id, instructionId, status: "failed", source });
      throw error;
    }
  }

  app.get("/health", async () => ({ status: "ok", service: "cooper2talk", timestamp: new Date().toISOString(), configured: { dograh: Boolean(config.DOGRAH_BASE_URL && config.DOGRAH_EVENT_SECRET), twilio: Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN), telnyx: Boolean(config.TELNYX_API_KEY), whatsapp: Boolean(config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID), database: Boolean(config.DATABASE_URL) } }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await repo.getUserByEmail(body.email);
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) fail(401, "Invalid email or password");
    const session = { id: randomUUID(), userId: user.id, csrfToken: randomBytes(24).toString("base64url"), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
    await repo.createSession(session);
    reply.setCookie("cooper_session", session.id, { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 7 * 86400 });
    return { user: publicUser(user), csrfToken: session.csrfToken };
  });
  app.post("/api/auth/logout", async (request, reply) => { const p = await principal(request); if (p) await repo.deleteSession(p.sessionId); reply.clearCookie("cooper_session", { path: "/" }); return { ok: true }; });
  app.get("/api/me", async (request) => { const p = await principal(request); return p ? { user: publicUser(p.user), csrfToken: p.csrfToken } : { user: null }; });
  app.get("/api/operators", async (request) => { await requireUser(request, ["admin"]); return { operators: (await repo.listUsers()).map(publicUser) }; });
  app.post("/api/operators", async (request) => { const p = await requireUser(request, ["admin"]); const body = operatorSchema.parse(request.body); if (await repo.getUserByEmail(body.email)) fail(409, "Email already exists"); const user: User = { id: randomUUID(), email: body.email.toLowerCase(), passwordHash: await bcrypt.hash(body.password, 12), role: body.role, createdAt: new Date().toISOString() }; await repo.createUser(user); await repo.writeAudit("operator.created", p.user.id, undefined, { userId: user.id, role: user.role }); return { user: publicUser(user) }; });
  app.get("/api/business", async (request) => { await requireUser(request); return { business: await repo.getBusinessConfig() }; });
  app.put("/api/business", async (request) => { const p = await requireUser(request, ["admin"]); const business = businessSchema.parse(request.body) as BusinessConfig; await repo.saveBusinessConfig(business); await repo.writeAudit("business.updated", p.user.id, undefined, {}); return { business }; });

  app.get("/api/calls", async (request) => { await requireUser(request); return { calls: await repo.listCalls() }; });
  app.get("/api/calls/:callId", async (request) => { await requireUser(request); const call = await getCall((request.params as any).callId); return { call, transcript: await repo.listTranscript(call.id), outbound: await repo.listOutboundForCall(call.id) }; });
  app.get("/api/reports/calls", async (request) => {
    await requireUser(request);
    const calls = await repo.listCalls();
    const reports = await Promise.all(calls.map(async (call) => {
      const summary = (await repo.listOutboundForCall(call.id)).find((message) => message.kind === "whatsapp_summary")?.body as { summary?: unknown } | undefined;
      return { call, summary: summary?.summary };
    }));
    return { reports };
  });
  app.post("/api/calls/:callId/injections", async (request) => {
    const p = await requireUser(request, ["admin", "supervisor"]); const call = await getCall((request.params as any).callId); if (call.status !== "active") fail(409, "Call is not active");
    const injectionBody = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    const { text } = injectionSchema.parse(injectionBody);
    return replyStatus(202, await injectOperatorInstruction(call, text, p, "operator_console", "call.inject"));
  });
  app.post("/api/calls/:callId/voice-instructions", async (request) => {
    const p = await requireUser(request, ["admin", "supervisor"]);
    const call = await getCall((request.params as any).callId);
    if (call.status !== "active") fail(409, "Call is not active");
    const mimeType = String(request.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase();
    if (!supportedVoiceMimeTypes.has(mimeType)) fail(415, "Unsupported voice recording format");
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) fail(400, "Voice recording is empty");
    if (request.body.length > MAX_VOICE_INSTRUCTION_BYTES) fail(413, "Voice recording is too large");
    const text = await clients.transcriber.transcribe(request.body, mimeType);
    return replyStatus(202, await injectOperatorInstruction(call, text, p, "operator_voice", "call.voice_inject"));
  });
  app.post("/api/calls/:callId/transfer", async (request) => { const p = await requireUser(request, ["admin", "supervisor"]); const call = await getCall((request.params as any).callId); const { destination } = transferSchema.parse(request.body); const result = await clients.telephony.transfer(call, destination); call.status = "transferred"; await repo.saveCall(call); await repo.writeAudit("call.transfer", p.user.id, call.id, { provider: call.provider, destination: result.destination }); broadcast("call.updated", call); return result; });
  app.post("/api/calls/:callId/end", async (request) => { const p = await requireUser(request, ["admin", "supervisor"]); const call = await getCall((request.params as any).callId); const result = await clients.telephony.end(call); await repo.writeAudit("call.end", p.user.id, call.id, { provider: call.provider }); return result; });

  app.post("/internal/dograh/events", { config: { rawBody: true } }, async (request) => {
    const raw = request.rawBody;
    if (!raw || !validSignature(config.DOGRAH_EVENT_SECRET, raw, request.headers["x-cooper-signature"] as string | undefined)) fail(401, "Invalid Dograh signature");
    const event = dograhEventSchema.parse(request.body) as DograhEvent; return callService.ingest(event);
  });

  app.get("/webhooks/whatsapp", async (request, reply) => { const q = request.query as any; if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WHATSAPP_VERIFY_TOKEN) return reply.type("text/plain").send(q["hub.challenge"]); fail(403, "Verification failed"); });
  app.post("/webhooks/whatsapp", { config: { rawBody: true } }, async (request) => {
    const raw = request.rawBody;
    if (!raw || !config.WHATSAPP_APP_SECRET || !validSignature(config.WHATSAPP_APP_SECRET, raw, request.headers["x-hub-signature-256"] as string | undefined)) fail(401, "Invalid WhatsApp signature");
    const entries: any[] = (request.body as any)?.entry ?? [];
    for (const change of entries.flatMap((e) => e.changes ?? [])) for (const message of change.value?.messages ?? []) await handleWhatsAppMessage(message, callService, repo, config, clients.dograh, broadcast);
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, (socket, request) => { void principal(request).then((p) => { if (!p) return socket.close(1008, "Unauthorized"); sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.send(JSON.stringify({ event: "ready", payload: { user: publicUser(p.user) } })); }); });
  if (config.NODE_ENV !== "production") app.post("/internal/simulate/dograh", async (request) => callService.ingest(dograhEventSchema.parse(request.body) as DograhEvent));
  app.setErrorHandler((error: any, _request, reply) => { app.log.error(error); reply.status(error.statusCode ?? 500).send({ error: error.message ?? "Internal error" }); });
  await repo.init();
  const admin = await repo.getUserByEmail(config.ADMIN_EMAIL);
  if (!admin) await repo.createUser({ id: randomUUID(), email: config.ADMIN_EMAIL.toLowerCase(), passwordHash: await bcrypt.hash(config.ADMIN_PASSWORD, 12), role: "admin", createdAt: new Date().toISOString() });
  const timer = setInterval(() => void outbox.processOne(), 500);
  timer.unref();
  const retentionTimer = setInterval(() => void repo.purgeTranscripts(new Date(Date.now() - config.TRANSCRIPT_RETENTION_DAYS * 86400000).toISOString()), 24 * 60 * 60 * 1000);
  retentionTimer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); clearInterval(retentionTimer); });
  return app;
}

function publicUser(user: User) { return { id: user.id, email: user.email, role: user.role }; }
function fail(statusCode: number, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function replyStatus(status: number, payload: unknown) { return { status, ...payload as any }; }
async function handleWhatsAppMessage(message: any, callService: CallService, repo: Repository, config: Config, dograh: InstructionClient, broadcast: (event: string, payload: unknown) => void) {
  const from = normalizeCanadianNumber(message.from);
  if (!from || !config.operatorNumbers.has(from) || message.type !== "text") return;
  const replyTo = message.context?.id as string | undefined;
  let call = replyTo ? await repo.findCallByWhatsAppMessage(replyTo) : undefined;
  if (!call) { const active = await callService.activeCalls(); if (active.length !== 1) return; call = active[0]; }
  const instructionId = stableInstructionId(message.id);
  const text = String(message.text?.body ?? "").trim(); if (!text) return;
  const transcript = { id: randomUUID(), callId: call.id, speaker: "operator" as const, text, source: "whatsapp" as const, occurredAt: new Date().toISOString() };
  await repo.addTranscript(transcript); await repo.writeAudit("whatsapp.inject", undefined, call.id, { messageId: message.id, from }); broadcast("transcript.message", transcript);
  await dograh.inject(call, text, instructionId); broadcast("injection.status", { callId: call.id, instructionId, status: "accepted", source: "whatsapp" });
}
