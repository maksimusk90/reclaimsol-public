import { describe, expect, it } from "vitest";
import { classifyAccountState, formatLamports } from "./scanner";
import { ReclaimReasonCode } from "./types";
import { evaluateAccountExtensions, parseExtensionTypesSafe } from "./extensions";
import { ExtensionType } from "@solana/spl-token";

const safeEmpty = {
  isInitialized: true,
  isZero: true,
  isNative: false,
  isFrozen: false,
  hasAuthority: true,
  unsupportedExtensions: false,
  withheldAmount: BigInt(0),
};

describe("MVP account classification", () => {
  it("marks a supported empty account reclaimable", () => {
    expect(classifyAccountState(safeEmpty)).toMatchObject({
      status: "reclaimable",
      reasonCode: ReclaimReasonCode.EmptyAccountEligible,
    });
  });

  it("never marks a non-empty account reclaimable", () => {
    expect(classifyAccountState({ ...safeEmpty, isZero: false })).toMatchObject({
      status: "has_tokens",
      reasonCode: ReclaimReasonCode.NonzeroBalance,
    });
  });

  it("keeps frozen empty accounts in review", () => {
    expect(classifyAccountState({ ...safeEmpty, isFrozen: true })).toMatchObject({
      status: "review_required",
      reasonCode: ReclaimReasonCode.FrozenAccount,
    });
  });

  it("excludes wrapped SOL accounts", () => {
    expect(classifyAccountState({ ...safeEmpty, isNative: true })).toMatchObject({
      status: "review_required",
      reasonCode: ReclaimReasonCode.WrappedSolUnsupported,
    });
  });

  it("requires review when withheld transfer fees remain", () => {
    expect(classifyAccountState({ ...safeEmpty, withheldAmount: BigInt(1) })).toMatchObject({
      status: "review_required",
      reasonCode: ReclaimReasonCode.WithheldTransferFee,
    });
  });

  it("fails closed for unsupported extensions or missing close authority, even when tokens remain", () => {
    expect(classifyAccountState({ ...safeEmpty, unsupportedExtensions: true }).status).toBe("unsupported");
    expect(classifyAccountState({ ...safeEmpty, isZero: false, unsupportedExtensions: true }).status).toBe("unsupported");
    expect(classifyAccountState({ ...safeEmpty, hasAuthority: false }).status).toBe("review_required");
  });
});

describe("lamport formatting", () => {
  it("formats SOL without floating-point arithmetic", () => {
    expect(formatLamports(BigInt(1234567890))).toBe("1.23456789");
    expect(formatLamports(BigInt(1000000000))).toBe("1");
    expect(formatLamports(BigInt(1))).toBe("0.000000001");
  });
});

describe("Token-2022 extension safety", () => {
  it("allows only the explicitly supported account extensions", () => {
    expect(
      evaluateAccountExtensions([
        ExtensionType.ImmutableOwner,
        ExtensionType.MemoTransfer,
        ExtensionType.TransferFeeAmount,
      ]).allowed,
    ).toBe(true);
  });

  it("fails closed for unknown extension identifiers", () => {
    const result = evaluateAccountExtensions([999 as ExtensionType]);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(ReclaimReasonCode.UnsupportedTokenExtension);
  });

  it("fails closed for truncated TLV extension data", () => {
    const malformed = Buffer.from([0xe7, 0x03, 0x04, 0x00, 0x01]);
    const types = parseExtensionTypesSafe(malformed);
    expect(types.length).toBeGreaterThan(0);
    expect(evaluateAccountExtensions(types).allowed).toBe(false);
  });

  it("rejects a known extension with an invalid payload length", () => {
    // ImmutableOwner is a zero-length account extension.
    // Here it incorrectly declares 4 bytes but contains only 1.
    const malformed = Buffer.from([0x07, 0x00, 0x04, 0x00, 0x01]);

    const types = parseExtensionTypesSafe(malformed);

    expect(evaluateAccountExtensions(types).allowed).toBe(false);
  });

  it("allows a valid zero-length ImmutableOwner extension", () => {
    const valid = Buffer.from([0x07, 0x00, 0x00, 0x00]);

    const types = parseExtensionTypesSafe(valid);

    expect(types).toEqual([ExtensionType.ImmutableOwner]);
    expect(evaluateAccountExtensions(types).allowed).toBe(true);
  });

  it("rejects a valid mint-only extension found in account TLV data", () => {
    // TransferFeeConfig is a mint extension, not an account extension.
    const extensionType = ExtensionType.TransferFeeConfig;
    const payloadLength = 108;
    const tlv = Buffer.alloc(4 + payloadLength);

    tlv.writeUInt16LE(extensionType, 0);
    tlv.writeUInt16LE(payloadLength, 2);

    const types = parseExtensionTypesSafe(tlv);

    expect(types).toEqual([extensionType]);

    const result = evaluateAccountExtensions(types);

    expect(result.allowed).toBe(false);
    expect(result.code).toBe(ReclaimReasonCode.UnsupportedTokenExtension);
  });
});


describe("additional reclaim safety checks", () => {
  it("rejects uninitialized accounts", () => {
    expect(classifyAccountState({
      ...safeEmpty,
      isInitialized: false,
    })).toMatchObject({
      status: "review_required",
      reasonCode: ReclaimReasonCode.UninitializedAccount,
    });
  });

  it("preserves the confidential extension reason code", () => {
    expect(classifyAccountState({
      ...safeEmpty,
      unsupportedExtensions: true,
      extensionReasonCode: ReclaimReasonCode.BlockedConfidentialExtension,
    })).toMatchObject({
      status: "unsupported",
      reasonCode: ReclaimReasonCode.BlockedConfidentialExtension,
    });
  });
});