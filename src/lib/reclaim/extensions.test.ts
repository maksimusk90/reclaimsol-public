// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ExtensionType, getTypeLen } from "@solana/spl-token";
import {
  evaluateAccountExtensions,
  parseExtensionTypesSafe,
  SUPPORTED_ACCOUNT_EXTENSIONS,
} from "./extensions";

function encodeExtensions(types: ExtensionType[]): Buffer {
  return Buffer.concat(types.map((type) => {
    const length = getTypeLen(type);
    const record = Buffer.alloc(4 + length);
    record.writeUInt16LE(type, 0);
    record.writeUInt16LE(length, 2);
    return record;
  }));
}

describe("Token-2022 account extension allowlist", () => {
  it("accepts every explicitly supported fixed-length account extension", () => {
    const types = [...SUPPORTED_ACCOUNT_EXTENSIONS];
    const parsed = parseExtensionTypesSafe(encodeExtensions(types));

    expect(parsed).toEqual(types);
    expect(evaluateAccountExtensions(parsed)).toEqual({ allowed: true });
  });

  it("rejects confidential transfer account extensions", () => {
    expect(
      evaluateAccountExtensions([ExtensionType.ConfidentialTransferAccount]),
    ).toMatchObject({
      allowed: false,
      unsupportedName: "ConfidentialTransferAccount",
    });
  });

  it("rejects unknown extension types instead of allowing them", () => {
    const unknown = 0x7ffe as ExtensionType;
    const parsed = parseExtensionTypesSafe(Buffer.from([0xfe, 0x7f, 0, 0]));

    expect(parsed).toEqual([unknown]);
    expect(evaluateAccountExtensions(parsed)).toMatchObject({
      allowed: false,
      unsupportedName: "Unknown extension (32766)",
    });
  });

  it("fails closed on a truncated TLV header", () => {
    const parsed = parseExtensionTypesSafe(Buffer.from([1, 0, 0]));

    expect(parsed).toHaveLength(1);
    expect(evaluateAccountExtensions(parsed)).toMatchObject({
      allowed: false,
      unsupportedName: "Malformed Token-2022 TLV data",
    });
  });

  it("fails closed when a fixed-size extension declares the wrong length", () => {
    const parsed = parseExtensionTypesSafe(Buffer.from([7, 0, 1, 0, 0]));

    expect(parsed).not.toEqual([ExtensionType.ImmutableOwner]);
    expect(evaluateAccountExtensions(parsed)).toMatchObject({
      allowed: false,
      unsupportedName: "Malformed Token-2022 TLV data",
    });
  });
});
