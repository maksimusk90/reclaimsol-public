import { describe, expect, it } from "vitest";
import { formatWalletAddress } from "../../src/lib/format-wallet-address";

describe("formatWalletAddress", () => {
  it("returns fallback for null", () => {
    expect(formatWalletAddress(null)).toBe("Not connected");
  });

  it("keeps short addresses unchanged", () => {
    expect(formatWalletAddress("123456789012")).toBe("123456789012");
  });

  it("shortens long wallet addresses", () => {
    expect(formatWalletAddress("1234567890ABCDEFGH")).toBe("1234...EFGH");
  });
});
