export function formatMoney(value: string | number, decimals = 2): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals
  }).format(numeric);
}

export function formatSignedMoney(value: string | number): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  const formatted = formatMoney(Math.abs(numeric));
  return `${numeric >= 0 ? "+" : "-"}${formatted}`;
}
