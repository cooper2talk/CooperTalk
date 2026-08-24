import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256 } from "../src/crypto.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryRepository } from "../src/repository.js";
import { CallService, CallSummaryService, OutboxWorker, WhatsAppClient, type CallSummaryGenerator, type VoiceInstructionTranscriber } from "../src/services.js";

const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000", SESSION_SECRET: "a-test-session-secret-long-enough", DOGRAH_EVENT_SECRET: "a-test-dograh-event-secret", WHATSAPP_VERIFY_TOKEN: "a-test-whatsapp-verify-token", ADMIN_EMAIL: "admin@example.ca", ADMIN_PASSWORD: "secure-demo-password", OPERATOR_NUMBERS: "+16474727980", WHATSAPP_SUMMARY_DELAY_SECONDS: "0", WHATSAPP_ALERT_ROUTES: JSON.stringify({ "+17053004321": { agentLabel: "Emma — Canadian Receptionist", callSummary: true }, "+14095060390": { agentLabel: "Nichole — ExcelLinx Project Manager Assistant", callSummary: false } }) });
const fallbackSummaryGenerator: CallSummaryGenerator = { generate: async () => ({ language: "english", update: "Fallback summary.", urgency: "Not stated", source: "fallback" }) };

async function setup(overrides: { transcriber?: VoiceInstructionTranscriber } = {}) { const app = await createApp(new MemoryRepository(), config, overrides); return app; }
function cookie(response: any) { return String(response.headers["set-cookie"]).split(";")[0]; }
function event() { return { id: "evt-1", type: "call.started", occurredAt: "2026-08-15T12:00:00.000Z", call: { dograhRunId: "run-42", twilioCallSid: "CA123", from: "4165550100", to: "7372508034", forwardedFrom: "6475550101" } }; }
function telnyxEvent() { return { id: "evt-telnyx-1", type: "call.started", occurredAt: "2026-08-15T12:01:00.000Z", call: { dograhRunId: "run-telnyx-42", provider: "telnyx", providerCallId: "v3:call-control-id", callLegId: "v3:call-leg-id", callSessionId: "v3:call-session-id", from: "4095060390", to: "4095060390", metadata: { workflowName: "Nichole - ExcelLinx Project Manager Assistant" } } }; }

test("rejects unsigned Dograh events and accepts signed events once", async () => {
  const app = await setup(); const payload = JSON.stringify(event());
  const blocked = await app.inject({ method: "POST", url: "/internal/dograh/events", payload, headers: { "content-type": "application/json" } });
  assert.equal(blocked.statusCode, 401);
  const signature = `sha256=${hmacSha256(config.DOGRAH_EVENT_SECRET, payload)}`;
  const accepted = await app.inject({ method: "POST", url: "/internal/dograh/events", payload, headers: { "content-type": "application/json", "x-cooper-signature": signature } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().call.originalCaller, "+16475550101");
  const duplicate = await app.inject({ method: "POST", url: "/internal/dograh/events", payload, headers: { "content-type": "application/json", "x-cooper-signature": signature } });
  assert.equal(duplicate.json().duplicate, true);
  await app.close();
});

test("supervisor injection requires an authenticated CSRF-protected session", async () => {
  const app = await setup(); const payload = JSON.stringify(event()); const signature = `sha256=${hmacSha256(config.DOGRAH_EVENT_SECRET, payload)}`;
  await app.inject({ method: "POST", url: "/internal/dograh/events", payload, headers: { "content-type": "application/json", "x-cooper-signature": signature } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.ca", password: "secure-demo-password" } });
  assert.equal(login.statusCode, 200); const csrf = login.json().csrfToken; const call = (await app.inject({ method: "GET", url: "/api/calls", headers: { cookie: cookie(login) } })).json().calls[0];
  const denied = await app.inject({ method: "POST", url: `/api/calls/${call.id}/injections`, payload: { text: "Close at four." }, headers: { cookie: cookie(login) } });
  assert.equal(denied.statusCode, 403);
  const accepted = await app.inject({ method: "POST", url: `/api/calls/${call.id}/injections`, payload: { text: "Close at four." }, headers: { cookie: cookie(login), "x-csrf-token": csrf } });
  assert.equal(accepted.statusCode, 200);
  const details = await app.inject({ method: "GET", url: `/api/calls/${call.id}`, headers: { cookie: cookie(login) } });
  assert.equal(details.json().transcript[0].speaker, "operator");
  await app.close();
});

test("Telnyx call-control IDs use the provider-neutral record and actions", async () => {
  const app = await setup(); const payload = JSON.stringify(telnyxEvent()); const signature = `sha256=${hmacSha256(config.DOGRAH_EVENT_SECRET, payload)}`;
  const accepted = await app.inject({ method: "POST", url: "/internal/dograh/events", payload, headers: { "content-type": "application/json", "x-cooper-signature": signature } });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual({ provider: accepted.json().call.provider, providerCallId: accepted.json().call.providerCallId, callLegId: accepted.json().call.callLegId, callSessionId: accepted.json().call.callSessionId }, { provider: "telnyx", providerCallId: "v3:call-control-id", callLegId: "v3:call-leg-id", callSessionId: "v3:call-session-id" });
  assert.equal(accepted.json().call.metadata.workflowName, "Nichole - ExcelLinx Project Manager Assistant");
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.ca", password: "secure-demo-password" } });
  const csrf = login.json().csrfToken; const call = (await app.inject({ method: "GET", url: "/api/calls", headers: { cookie: cookie(login) } })).json().calls[0];
  const transfer = await app.inject({ method: "POST", url: `/api/calls/${call.id}/transfer`, payload: { destination: "+14165550100" }, headers: { cookie: cookie(login), "x-csrf-token": csrf } });
  assert.equal(transfer.statusCode, 200); assert.deepEqual(transfer.json(), { simulated: true, provider: "telnyx", destination: "+14165550100" });
  const end = await app.inject({ method: "POST", url: `/api/calls/${call.id}/end`, headers: { cookie: cookie(login), "x-csrf-token": csrf } });
  assert.equal(end.statusCode, 200); assert.deepEqual(end.json(), { simulated: true, provider: "telnyx" });
  await app.close();
});

test("WhatsApp alerts are limited to the two approved agent numbers and include their labels", async () => {
  const repo = new MemoryRepository();
  const service = new CallService(repo, config, () => {});
  await service.ingest(telnyxEvent());
  const nicholeAlert = [...repo.outbound.values()];
  assert.equal(nicholeAlert.length, 1);
  assert.equal(nicholeAlert[0].kind, "whatsapp_alert");
  assert.equal((nicholeAlert[0].body as any).operator, "+16474727980");
  assert.equal((nicholeAlert[0].body as any).agentLabel, "Nichole — ExcelLinx Project Manager Assistant");
  const nicholeTemplate = new WhatsAppClient(config).alertBody("+16474727980", (nicholeAlert[0].body as any).call, (nicholeAlert[0].body as any).agentLabel);
  assert.deepEqual(nicholeTemplate.template.components[0].parameters.map((parameter) => parameter.text), ["Nichole — ExcelLinx Project Manager Assistant", "+14095060390", "+14095060390"]);

  await service.ingest({ ...event(), id: "evt-emma-alert", call: { ...event().call, dograhRunId: "run-emma-alert", to: "7053004321" } });
  await service.ingest({ ...event(), id: "evt-unrecognized-alert", call: { ...event().call, dograhRunId: "run-unrecognized-alert", to: "4165550199" } });
  const alerts = [...repo.outbound.values()];
  assert.equal(alerts.length, 2);
  assert.equal((alerts.find((item) => (item.body as any).call.dograhRunId === "run-emma-alert")?.body as any).agentLabel, "Emma — Canadian Receptionist");
});

test("missing Meta sender credentials fail the queued alert instead of simulating delivery", async () => {
  const repo = new MemoryRepository();
  const service = new CallService(repo, config, () => {});
  await service.ingest(telnyxEvent());
  const worker = new OutboxWorker(repo, new WhatsAppClient(config), fallbackSummaryGenerator);
  assert.equal(await worker.processOne(), true);
  const message = [...repo.outbound.values()][0];
  assert.equal(message.deliveredAt, undefined);
  assert.equal(message.externalId, undefined);
  assert.equal(message.attempts, 1);
  assert.equal(message.lastError, "WhatsApp Cloud API sender credentials are not configured");
});

test("voice instruction transcribes in memory and uses the normal injection path", async () => {
  const transcriber: VoiceInstructionTranscriber = { transcribe: async (audio, mimeType) => { assert.equal(mimeType, "audio/webm"); assert.deepEqual([...audio], [1, 2, 3]); return "Please tell them we close at four."; } };
  const app = await setup({ transcriber }); const payload = JSON.stringify(event()); const signature = `sha256=${hmacSha256(config.DOGRAH_EVENT_SECRET, payload)}`;
  await app.inject({ method: "POST", url: "/internal/dograh/events", payload, headers: { "content-type": "application/json", "x-cooper-signature": signature } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.ca", password: "secure-demo-password" } });
  const csrf = login.json().csrfToken; const call = (await app.inject({ method: "GET", url: "/api/calls", headers: { cookie: cookie(login) } })).json().calls[0];
  const rejected = await app.inject({ method: "POST", url: `/api/calls/${call.id}/voice-instructions`, payload: Buffer.from([1, 2, 3]), headers: { cookie: cookie(login), "content-type": "audio/webm" } });
  assert.equal(rejected.statusCode, 403);
  const accepted = await app.inject({ method: "POST", url: `/api/calls/${call.id}/voice-instructions`, payload: Buffer.from([1, 2, 3]), headers: { cookie: cookie(login), "content-type": "audio/webm", "x-csrf-token": csrf } });
  assert.equal(accepted.statusCode, 200); assert.equal(accepted.json().text, "Please tell them we close at four.");
  const details = await app.inject({ method: "GET", url: `/api/calls/${call.id}`, headers: { cookie: cookie(login) } });
  assert.equal(details.json().transcript[0].source, "operator_voice");
  const unsupported = await app.inject({ method: "POST", url: `/api/calls/${call.id}/voice-instructions`, payload: Buffer.from([1]), headers: { cookie: cookie(login), "content-type": "application/octet-stream", "x-csrf-token": csrf } });
  assert.equal(unsupported.statusCode, 415);
  await app.close();
});

test("Emma call completion queues one Hinglish summary and sends it through the approved template", async () => {
  const repo = new MemoryRepository();
  const service = new CallService(repo, config, () => {});
  const call = { ...event(), id: "evt-emma-start", call: { ...event().call, dograhRunId: "run-emma-summary", to: "7053004321", from: "4165550100" } };
  await service.ingest(call);
  await service.ingest({ id: "evt-emma-turn", type: "transcript.final", occurredAt: "2026-08-15T12:00:04.000Z", call: call.call, payload: { speaker: "caller", text: "Mujhe closing documents ke baare mein follow-up chahiye." } });
  await service.ingest({ id: "evt-emma-end", type: "call.ended", occurredAt: "2026-08-15T12:01:00.000Z", call: call.call });
  await service.ingest({ id: "evt-emma-end-duplicate", type: "call.ended", occurredAt: "2026-08-15T12:01:00.000Z", call: call.call });

  const queued = [...repo.outbound.values()].filter((message) => message.kind === "whatsapp_summary");
  assert.equal(queued.length, 1);
  const sent: Record<string, any>[] = [];
  const whatsapp = {
    alertBody: () => ({ type: "template", template: { name: "cooper_live_call_alert" } }),
    summaryBody: (_to: string, _call: unknown, summary: any) => ({ type: "template", template: { name: "cooper_call_summary", components: [{ type: "body", parameters: [{ text: "Caller" }, { text: "1m 0s" }, { text: summary.update }, { text: summary.urgency }] }] } }),
    send: async (body: Record<string, unknown>) => { sent.push(body); return { externalId: "wamid-" + sent.length }; }
  } as unknown as WhatsAppClient;
  const summaries: CallSummaryGenerator = { generate: async () => ({ language: "hinglish", update: "Caller ne closing documents ke baare mein follow-up manga hai.", urgency: "Mention nahi hua", source: "ai" }) };
  const worker = new OutboxWorker(repo, whatsapp, summaries);
  await worker.processOne();
  await worker.processOne();
  assert.equal(sent[1].template.name, "cooper_call_summary");
  assert.equal(sent[1].template.components[0].parameters[2].text, "Caller ne closing documents ke baare mein follow-up manga hai.");
});

test("summary fallback preserves Hinglish or English caller text when Groq is unavailable", async () => {
  const call = { id: "summary-call", dograhRunId: "summary-run", provider: "telnyx" as const, status: "completed" as const, startedAt: "2026-08-15T12:00:00.000Z", endedAt: "2026-08-15T12:01:00.000Z", metadata: {} };
  const failing = new CallSummaryService(loadConfig({ ...config, GROQ_API_KEY: "test-key" }), async () => new Response("rate limited", { status: 429 }));
  const hinglish = await failing.generate(call, [{ id: "t1", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "Mujhe documents ke baare mein baat karni hai." }]);
  const english = await failing.generate(call, [{ id: "t2", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "I need to discuss the closing documents." }]);
  assert.deepEqual({ language: hinglish.language, source: hinglish.source }, { language: "hinglish", source: "fallback" });
  assert.match(hinglish.update, /Mujhe documents/);
  assert.deepEqual({ language: english.language, source: english.source }, { language: "english", source: "fallback" });
  assert.match(english.update, /closing documents/);
});

test("summary fallback ignores a final farewell when useful caller details exist", async () => {
  const call = { id: "summary-fallback-call", dograhRunId: "summary-fallback-run", provider: "telnyx" as const, status: "completed" as const, startedAt: "2026-08-15T12:00:00.000Z", endedAt: "2026-08-15T12:01:00.000Z", metadata: {} };
  const failing = new CallSummaryService(loadConfig({ ...config, GROQ_API_KEY: "test-key" }), async () => new Response("rate limited", { status: 429 }));
  const summary = await failing.generate(call, [
    { id: "t1", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "Please remind Surinder to pick me up at 6 PM." },
    { id: "t2", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "Ok, bye Emma. Take care. Good night." }
  ]);
  assert.match(summary.update, /pick me up at 6 PM/);
  assert.doesNotMatch(summary.update, /Good night/);
});

test("summary generator asks Groq for a factual operator handoff from the call conversation", async () => {
  const call = { id: "summary-ai-call", dograhRunId: "summary-ai-run", provider: "telnyx" as const, status: "completed" as const, startedAt: "2026-08-15T12:00:00.000Z", endedAt: "2026-08-15T12:03:00.000Z", metadata: {} };
  let requestBody = "";
  const generator = new CallSummaryService(loadConfig({ ...config, GROQ_API_KEY: "test-key" }), async (_url, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"language":"english","update":"Caller asked Surinder to review the closing documents for a Toronto property and requested a follow-up.","urgency":"Not stated"}' } }] }), { status: 200 });
  });
  const summary = await generator.generate(call, [
    { id: "t1", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "I need Surinder to review the closing documents for my Toronto property." },
    { id: "t2", callId: call.id, speaker: "assistant", source: "dograh", occurredAt: call.startedAt, text: "I can take the details for him." },
    { id: "t3", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "Please ask him to follow up." }
  ]);
  assert.equal(summary.source, "ai");
  assert.match(summary.update, /Toronto property/);
  assert.match(requestBody, /actual reason for calling/);
  assert.match(requestBody, /Caller: I need Surinder/);
});

test("summary generator accepts JSON surrounded by model commentary", async () => {
  const call = { id: "summary-json-call", dograhRunId: "summary-json-run", provider: "telnyx" as const, status: "completed" as const, startedAt: "2026-08-15T12:00:00.000Z", endedAt: "2026-08-15T12:01:00.000Z", metadata: {} };
  const generator = new CallSummaryService(loadConfig({ ...config, GROQ_API_KEY: "test-key" }), async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Result: {"language":"english","update":"Caller requested a document review.","urgency":"Not stated"}' } }] }), { status: 200 }));
  const summary = await generator.generate(call, [{ id: "t1", callId: call.id, speaker: "caller", source: "dograh", occurredAt: call.startedAt, text: "Please review my documents." }]);
  assert.equal(summary.source, "ai");
  assert.equal(summary.update, "Caller requested a document review.");
});
