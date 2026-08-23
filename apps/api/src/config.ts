import { z } from "zod";

const e164Number = z.string().regex(/^\+[1-9]\d{7,14}$/, "must be an E.164 phone number");
const emmaNumber = "+17053004321";
const whatsappAlertRoute = z.object({
  agentLabel: z.string().trim().min(1).max(120),
  callSummary: z.boolean().optional()
});
const whatsappAlertRoutes = z.record(e164Number, whatsappAlertRoute);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().default(""),
  SESSION_SECRET: z.string().min(16).default("development-session-secret-change-me"),
  DOGRAH_BASE_URL: z.string().url().optional(),
  DOGRAH_API_KEY: z.string().optional(),
  DOGRAH_EVENT_SECRET: z.string().min(16).default("development-dograh-event-secret"),
  GROQ_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_PHONE_NUMBER: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).default("development-whatsapp-verify-token"),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_ALERT_TEMPLATE: z.string().default("cooper_live_call_alert"),
  WHATSAPP_SUMMARY_TEMPLATE: z.string().default("cooper_call_summary"),
  WHATSAPP_SUMMARY_DELAY_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
  WHATSAPP_ALERT_ROUTES: z.string().default(""),
  OPERATOR_NUMBERS: z.string().default(""),
  ADMIN_EMAIL: z.string().email().default("admin@example.ca"),
  ADMIN_PASSWORD: z.string().min(12).default("change-me-now-123"),
  TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30)
});

export type WhatsAppAlertRoute = z.infer<typeof whatsappAlertRoute>;
export type Config = z.infer<typeof schema> & {
  operatorNumbers: Set<string>;
  whatsappAlertRoutes: Map<string, WhatsAppAlertRoute>;
};

export function loadConfig(env = process.env): Config {
  const parsed = schema.parse(env);
  let routes: Record<string, WhatsAppAlertRoute> = {};
  if (parsed.WHATSAPP_ALERT_ROUTES.trim()) {
    try {
      routes = whatsappAlertRoutes.parse(JSON.parse(parsed.WHATSAPP_ALERT_ROUTES));
    } catch (error) {
      throw new Error(`Invalid WHATSAPP_ALERT_ROUTES: ${error instanceof Error ? error.message : "must be a JSON route map"}`);
    }
  }
  return {
    ...parsed,
    operatorNumbers: new Set(parsed.OPERATOR_NUMBERS.split(",").map((v) => v.trim()).filter(Boolean)),
    whatsappAlertRoutes: new Map(Object.entries(routes).map(([number, route]) => [
      number,
      { ...route, callSummary: route.callSummary ?? number === emmaNumber }
    ]))
  };
}
