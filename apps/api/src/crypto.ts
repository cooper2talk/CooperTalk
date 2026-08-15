import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256(secret: string, body: Buffer | string) { return createHmac("sha256", secret).update(body).digest("hex"); }
export function validSignature(secret: string, body: Buffer | string, header: string | undefined, prefix = "sha256=") {
  if (!header?.startsWith(prefix)) return false;
  const expected = Buffer.from(hmacSha256(secret, body), "hex");
  const actual = Buffer.from(header.slice(prefix.length), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
