import {
  ExtensionType,
  getTypeLen,
} from "@solana/spl-token";
import { ReclaimReasonCode } from "./types";

/**
 * Account extensions explicitly reviewed for the MVP close-only flow.
 * Unknown, malformed and unsupported extensions fail closed.
 */
export const SUPPORTED_ACCOUNT_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.ImmutableOwner,
  ExtensionType.TransferFeeAmount,
  ExtensionType.MemoTransfer,
  ExtensionType.CpiGuard,
  ExtensionType.NonTransferableAccount,
  ExtensionType.TransferHookAccount,
]);

export const CONFIDENTIAL_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.ConfidentialTransferAccount,
  ExtensionType.ConfidentialTransferMint,
]);

// Reserved sentinel: it can never be treated as a supported extension.
const MALFORMED_EXTENSION = 0xffff as ExtensionType;

export function extensionName(type: ExtensionType | number): string {
  if (type === MALFORMED_EXTENSION) {
    return "Malformed Token-2022 TLV data";
  }

  return ExtensionType[type as ExtensionType] ?? `Unknown extension (${type})`;
}

/**
 * Parse account TLV data without relying on the SDK's unchecked parser.
 *
 * Every record must have a complete 4-byte header and its declared payload
 * must fit inside the buffer. Known fixed-size extensions must also have
 * their exact SDK-defined payload length.
 *
 * Variable-length and unknown types are retained for the allowlist to reject.
 * Any malformed record adds a fail-closed sentinel and stops parsing.
 */
export function parseExtensionTypesSafe(tlvData: Buffer): ExtensionType[] {
  const types: ExtensionType[] = [];
  let offset = 0;

  while (offset < tlvData.length) {
    if (tlvData.length - offset < 4) {
      types.push(MALFORMED_EXTENSION);
      break;
    }

    const extensionType = tlvData.readUInt16LE(offset) as ExtensionType;
    const extensionLength = tlvData.readUInt16LE(offset + 2);
    offset += 4;

    if (extensionLength > tlvData.length - offset) {
      types.push(MALFORMED_EXTENSION);
      break;
    }

    try {
      const expectedLength = getTypeLen(extensionType);

      if (extensionLength !== expectedLength) {
        types.push(MALFORMED_EXTENSION);
        break;
      }
    } catch {
      // Unknown and variable-length types are retained. They are not in
      // the supported account-extension allowlist and will be rejected.
    }

    types.push(extensionType);
    offset += extensionLength;
  }

  return types;
}

export function evaluateAccountExtensions(types: ExtensionType[]): {
  allowed: boolean;
  code?: ReclaimReasonCode;
  unsupportedName?: string;
} {
  for (const type of types) {
    if (CONFIDENTIAL_EXTENSIONS.has(type)) {
      return {
        allowed: false,
        code: ReclaimReasonCode.BlockedConfidentialExtension,
        unsupportedName: extensionName(type),
      };
    }

    if (!SUPPORTED_ACCOUNT_EXTENSIONS.has(type)) {
      return {
        allowed: false,
        code: ReclaimReasonCode.UnsupportedTokenExtension,
        unsupportedName: extensionName(type),
      };
    }
  }

  return { allowed: true };
}