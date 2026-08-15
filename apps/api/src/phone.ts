export function normalizeCanadianNumber(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return value.startsWith("+") && digits.length >= 8 ? `+${digits}` : undefined;
}

export function chooseOriginalCaller(input: { from?: string; originalCaller?: string; forwardedFrom?: string }): string | undefined {
  return normalizeCanadianNumber(input.originalCaller) ?? normalizeCanadianNumber(input.forwardedFrom) ?? normalizeCanadianNumber(input.from);
}
