import { Transaction } from "@solana/web3.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Phantom's injected provider and Wallet Adapter can return Transaction
 * instances created in a different JS realm. `instanceof Transaction` is
 * realm-sensitive, so normalize a serialized legacy transaction into this
 * application's web3.js realm before applying the integrity checks.
 *
 * This function does not alter the serialized message. Transaction.from()
 * parses the wallet-returned bytes; callers must still compare the message,
 * verify the signer and cryptographic signature, and only then submit it.
 */
export function normalizeWalletSignedTransaction(value: unknown): Transaction {
  if (value instanceof Transaction) return value;
  if (!isRecord(value) || typeof value.serialize !== "function") {
    throw new Error(`Wallet returned an unsupported transaction object (${describeWalletTransactionResult(value)}).`);
  }

  let serialized: unknown;
  try {
    serialized = value.serialize.call(value, {
      requireAllSignatures: false,
      verifySignatures: false,
    });
  } catch (error) {
    throw new Error(
      `Wallet transaction object could not be serialized (${describeWalletTransactionResult(value)}; serialize error: ${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (!(serialized instanceof Uint8Array) || serialized.length === 0) {
    throw new Error(
      `Wallet transaction serialize() returned an invalid byte buffer (${describeWalletTransactionResult(value)}).`,
    );
  }

  try {
    return Transaction.from(serialized);
  } catch (error) {
    throw new Error(
      `Wallet transaction bytes are not a parseable legacy transaction (${describeWalletTransactionResult(value)}; parse error: ${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** Returns structural metadata only; never dumps signatures or transaction bytes. */
export function describeWalletTransactionResult(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const primitiveType = typeof value;
  if (!isRecord(value)) return primitiveType;

  let constructorName = "unknown";
  try {
    const constructor = value.constructor;
    if (typeof constructor === "function" && typeof constructor.name === "string") {
      constructorName = constructor.name;
    }
  } catch {
    constructorName = "unreadable";
  }

  const methodNames = ["serialize", "serializeMessage", "compileMessage"] as const;
  const methods = methodNames.map((name) => `${name}=${typeof value[name]}`).join(",");
  let signatureCount = "unavailable";
  try {
    if (Array.isArray(value.signatures)) signatureCount = String(value.signatures.length);
  } catch {
    signatureCount = "unreadable";
  }

  let messageVersion = "unavailable";
  try {
    const message = value.message;
    if (isRecord(message) && (typeof message.version === "string" || typeof message.version === "number")) {
      messageVersion = String(message.version);
    }
  } catch {
    messageVersion = "unreadable";
  }

  let keys = "unavailable";
  try {
    keys = Object.keys(value).slice(0, 20).join(",") || "(none)";
  } catch {
    keys = "unreadable";
  }

  return `type=${primitiveType}; constructor=${constructorName}; ${methods}; signatures=${signatureCount}; messageVersion=${messageVersion}; keys=[${keys}]`;
}