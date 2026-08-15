import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().default(""),
  SESSION_SECRET: z.string().min(16).default("development-session-secret-change-me"),
  DOGRAH_BASE_URL: z.string().url().optional(),
  DOGRAH_API_KEY: z.string().optional(),
  DOGRAH_EVENT_SECRET: z.string().min(16).default("development-dograh-event-secret"),
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
  OPERATOR_NUMBERS: z.string().default(""),
  ADMIN_EMAIL: z.string().email().default("admin@example.ca"),
  ADMIN_PASSWORD: z.string().min(12).default("change-me-now-123"),
  TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30)
});

export type Config = z.infer<typeof schema> & { operatorNumbers: Set<string> };
export function loadConfig(env = process.env): Config {
  const parsed = schema.parse(env);
  return { ...parsed, operatorNumbers: new Set(parsed.OPERATOR_NUMBERS.split(",").map((v) => v.trim()).filter(Boolean)) };
}
