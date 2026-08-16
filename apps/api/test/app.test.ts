import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256 } from "../src/crypto.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryRepository } from "../src/repository.js";

const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000", SESSION_SECRET: "a-test-session-secret-long-enough", DOGRAH_EVENT_SECRET: "a-test-dograh-event-secret", WHATSAPP_VERIFY_TOKEN: "a-test-whatsapp-verify-token", ADMIN_EMAIL: "admin@example.ca", ADMIN_PASSWORD: "secure-demo-password" });

async function setup() { const app = await createApp(new MemoryRepository(), config); return app; }
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
