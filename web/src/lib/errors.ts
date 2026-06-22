function readString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) {
    return null;
  }

  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

function readCode(value: unknown) {
  if (!value || typeof value !== "object" || !("code" in value)) {
    return null;
  }

  const code = (value as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? String(code) : null;
}

function readErrorFields(error: unknown, depth = 0): string[] {
  if (!error || depth > 5) {
    return [];
  }

  const fields: string[] = [];
  const name = readString(error, "name");
  const shortMessage = readString(error, "shortMessage");
  const details = readString(error, "details");
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : readString(error, "message");
  const code = readCode(error);

  if (name) {
    fields.push(name);
  }
  if (code) {
    fields.push(`code ${code}`);
  }
  if (shortMessage) {
    fields.push(shortMessage);
  }
  if (details) {
    fields.push(details);
  }
  if (message) {
    fields.push(message.split("\n\n")[0] ?? message);
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const data = record.data;
    if (data) {
      if (typeof data === "string") {
        fields.push(data);
      } else {
        fields.push(...readErrorFields(data, depth + 1));
      }
    }
    if ("cause" in record) {
      fields.push(...readErrorFields(record.cause, depth + 1));
    }
  }

  return fields;
}

export function isUserRejectedRequest(error: unknown, depth = 0): boolean {
  if (!error || depth > 4) {
    return false;
  }

  if (readCode(error) === "4001") {
    return true;
  }

  const name = readString(error, "name")?.toLowerCase() ?? "";
  const shortMessage = readString(error, "shortMessage")?.toLowerCase() ?? "";
  const details = readString(error, "details")?.toLowerCase() ?? "";
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : typeof error === "string"
      ? error.toLowerCase()
      : readString(error, "message")?.toLowerCase() ?? "";
  const combined = `${name}\n${shortMessage}\n${details}\n${message}`;

  if (
    combined.includes("userrejectedrequesterror")
    || combined.includes("user rejected")
    || combined.includes("user denied")
    || combined.includes("denied transaction signature")
    || combined.includes("rejected the request")
  ) {
    return true;
  }

  if (error && typeof error === "object" && "cause" in error) {
    return isUserRejectedRequest((error as { cause?: unknown }).cause, depth + 1);
  }

  return false;
}

export function describeActionError(error: unknown, fallback = "Transaction failed.") {
  if (isUserRejectedRequest(error)) {
    return "Transaction cancelled in wallet.";
  }

  const fields = Array.from(new Set(readErrorFields(error).filter(Boolean)));
  const hasInternalRpc = fields.some((field) => field.includes("-32603") || field.toLowerCase().includes("internal error"));
  const meaningful = fields.find((field) => {
    const normalized = field.toLowerCase();
    return !normalized.includes("rpcerror(-32603)")
      && normalized !== "internal error"
      && normalized !== "rpcerror"
      && normalized !== "code -32603";
  });
  if (hasInternalRpc && meaningful) {
    return `Wallet RPC internal error: ${meaningful}`;
  }
  if (fields.length > 0) {
    return fields[0] ?? fallback;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}
