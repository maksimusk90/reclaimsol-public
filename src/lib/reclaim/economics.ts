export type BatchEconomicInput = {
  grossRentLamports: bigint;
  serviceFeeLamports: bigint;
  estimatedNetworkFeeLamports: bigint;
  feePayerBalanceLamports: bigint;
};

export type BatchEconomicReview = {
  estimatedNetRecoveredLamports: bigint;
  estimatedNetworkFeeLamports: bigint;
  feePayerBalanceLamports: bigint;
};

/**
 * Enforces the economics of the exact prepared transaction before wallet signing.
 * Reclaimed rent is deliberately excluded from the fee-payer balance check.
 */
export function validateBatchEconomics(input: BatchEconomicInput): BatchEconomicReview {
  const {
    grossRentLamports,
    serviceFeeLamports,
    estimatedNetworkFeeLamports,
    feePayerBalanceLamports,
  } = input;

  if (
    grossRentLamports < BigInt(0) ||
    serviceFeeLamports < BigInt(0) ||
    estimatedNetworkFeeLamports <= BigInt(0) ||
    feePayerBalanceLamports < BigInt(0) ||
    serviceFeeLamports > grossRentLamports
  ) {
    throw new Error("Batch economics contain invalid lamport values.");
  }

  const estimatedNetRecoveredLamports =
    grossRentLamports - serviceFeeLamports - estimatedNetworkFeeLamports;

  if (estimatedNetRecoveredLamports <= BigInt(0)) {
    throw new Error(
      "Estimated net recovery after service and network fees is zero or negative. This batch cannot be signed.",
    );
  }

  if (feePayerBalanceLamports < estimatedNetworkFeeLamports) {
    throw new Error(
      "Insufficient pre-existing SOL balance to pay the estimated network fee. Recovered rent cannot fund the upfront fee-payer balance requirement.",
    );
  }

  return {
    estimatedNetRecoveredLamports,
    estimatedNetworkFeeLamports,
    feePayerBalanceLamports,
  };
}
