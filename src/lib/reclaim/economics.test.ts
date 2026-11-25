// @vitest-environment node

import { describe, expect, it } from "vitest";
import { validateBatchEconomics } from "./economics";

describe("validateBatchEconomics", () => {
  it("calculates net after service and network fees", () => {
    expect(validateBatchEconomics({
      grossRentLamports: BigInt(1_000_000),
      serviceFeeLamports: BigInt(150_000),
      estimatedNetworkFeeLamports: BigInt(5_000),
      feePayerBalanceLamports: BigInt(10_000),
    })).toEqual({
      estimatedNetRecoveredLamports: BigInt(845_000),
      estimatedNetworkFeeLamports: BigInt(5_000),
      feePayerBalanceLamports: BigInt(10_000),
    });
  });

  it("blocks a non-positive estimated net", () => {
    expect(() => validateBatchEconomics({
      grossRentLamports: BigInt(100),
      serviceFeeLamports: BigInt(15),
      estimatedNetworkFeeLamports: BigInt(85),
      feePayerBalanceLamports: BigInt(100),
    })).toThrow(/zero or negative/i);
  });

  it("requires pre-existing fee-payer balance and does not count recovered rent", () => {
    expect(() => validateBatchEconomics({
      grossRentLamports: BigInt(2_000_000),
      serviceFeeLamports: BigInt(300_000),
      estimatedNetworkFeeLamports: BigInt(5_000),
      feePayerBalanceLamports: BigInt(4_999),
    })).toThrow(/pre-existing SOL balance/i);
  });

  it("rejects a missing zero network-fee estimate", () => {
    expect(() => validateBatchEconomics({
      grossRentLamports: BigInt(1_000_000),
      serviceFeeLamports: BigInt(150_000),
      estimatedNetworkFeeLamports: BigInt(0),
      feePayerBalanceLamports: BigInt(10_000),
    })).toThrow(/invalid lamport values/i);
  });

  it("rejects inconsistent or negative lamport inputs", () => {
    expect(() => validateBatchEconomics({
      grossRentLamports: BigInt(100),
      serviceFeeLamports: BigInt(101),
      estimatedNetworkFeeLamports: BigInt(1),
      feePayerBalanceLamports: BigInt(10),
    })).toThrow(/invalid lamport values/i);
  });
});
