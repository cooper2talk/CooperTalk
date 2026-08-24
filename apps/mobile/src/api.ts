import * as SecureStore from "expo-secure-store";

export type Role = "admin" | "supervisor" | "viewer";
export type User = { id: string; email: string; role: Role };
export type Call = { id: string; provider: "twilio" | "telnyx"; fromNumber?: string; originalCaller?: string; status: "active" | "completed" | "failed" | "transferred"; startedAt: string; endedAt?: string; aiState?: string; metadata: Record<string, string | undefined> };
export type Transcript = { id: string; callId: string; speaker: "caller" | "assistant" | "operator"; text: string; source: string };
export type Outbound = { id: string; kind: string; body: { summary?: { update?: string; urgency?: string } }; attempts: number; deliveredAt?: string; failedAt?: string; lastError?: string };
export type Report = { call: Call; summary?: { update?: string; urgency?: string } };

const ACCESS_KEY = "cooper-mobile-access";
const REFRESH_KEY = "cooper-mobile-refresh";
const API_BASE = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://34-130-230-27.sslip.io").replace(/\/$/, "");

export class ApiClient {
  private accessToken?: string;
  private refreshToken?: string;

  async restore() {
    this.accessToken = await SecureStore.getItemAsync(ACCESS_KEY) ?? undefined;
    this.refreshToken = await SecureStore.getItemAsync(REFRESH_KEY) ?? undefined;
    if (!this.accessToken || !this.refreshToken) return undefined;
    try { return (await this.request<{ user: User }>("/api/mobile/me")).user; }
    catch { return this.refresh().then((value) => value.user).catch(() => undefined); }
  }

  async login(email: string, password: string) {
    const response = await this.raw<{ user: User; accessToken: string; refreshToken: string }>("/api/mobile/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    await this.save(response.accessToken, response.refreshToken);
    return response.user;
  }

  async logout() {
    try { await this.request("/api/mobile/auth/logout", { method: "POST" }); } finally { await this.clear(); }
  }

  async request<T = any>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const response = await this.raw<T>(path, init, this.accessToken);
    return response;
  }

  async requestWithRefresh<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    try { return await this.request<T>(path, init); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      await this.refresh();
      return this.request<T>(path, init, true);
    }
  }

  async refresh() {
    if (!this.refreshToken) throw new Error("Sign in required");
    const response = await this.raw<{ user: User; accessToken: string; refreshToken: string }>("/api/mobile/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: this.refreshToken }) });
    await this.save(response.accessToken, response.refreshToken);
    return response;
  }

  async registerDevice(pushToken: string, platform: "ios" | "android", preferences = { callAlerts: true, summaryAlerts: true, deliveryAlerts: true }) {
    return this.requestWithRefresh<{ device: unknown }>("/api/mobile/devices", { method: "POST", body: JSON.stringify({ pushToken, platform, preferences }) });
  }

  websocketUrl() { return API_BASE.replace(/^http/, "ws") + "/ws"; }
  authorization() { return this.accessToken ? `Bearer ${this.accessToken}` : ""; }

  private async raw<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers: Record<string, string> = { ...(init.body instanceof Blob ? {} : { "content-type": "application/json" }), ...(init.headers as Record<string, string> ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, payload.error ?? "Request failed");
    return payload as T;
  }
  private async save(accessToken: string, refreshToken: string) { this.accessToken = accessToken; this.refreshToken = refreshToken; await SecureStore.setItemAsync(ACCESS_KEY, accessToken); await SecureStore.setItemAsync(REFRESH_KEY, refreshToken); }
  private async clear() { this.accessToken = undefined; this.refreshToken = undefined; await SecureStore.deleteItemAsync(ACCESS_KEY); await SecureStore.deleteItemAsync(REFRESH_KEY); }
}

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const api = new ApiClient();
