import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import {
  getTransferFeeAmount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import { scanWallet } from "./scanner";

vi.mock("@solana/spl-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/spl-token")>();

  return {
    ...actual,
    unpackAccount: vi.fn(),
    getTransferFeeAmount: vi.fn(() => null),
  };
});

const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

function makeAccount(
  owner: PublicKey,
  lamports: number,
  address = Keypair.generate().publicKey,
) {
  return {
    pubkey: address,
    account: {
      executable: false,
      owner,
      lamports,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    },
  };
}

function makeResponse(
  value: ReturnType<typeof makeAccount>[],
  slot: number,
) {
  return {
    context: { slot },
    value,
  };
}

function makeParsedAccount() {
  return {
    mint,
    owner: wallet,
    amount: BigInt(0),
    isNative: false,
    isFrozen: false,
    isInitialized: true,
    closeAuthority: null,
    tlvData: Buffer.alloc(0),
  };
}

function makeConnection(
  splAccounts: ReturnType<typeof makeAccount>[],
  token2022Accounts: ReturnType<typeof makeAccount>[],
): Connection {
  return {
    getBalanceAndContext: vi.fn().mockResolvedValue({
      context: { slot: 120 },
      value: 2_000_000_000,
    }),
    getTokenAccountsByOwner: vi.fn()
      .mockResolvedValueOnce(makeResponse(splAccounts, 115))
      .mockResolvedValueOnce(makeResponse(token2022Accounts, 110)),
  } as unknown as Connection;
}

describe("scanWallet RPC integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(unpackAccount).mockImplementation(
      () => makeParsedAccount() as never,
    );
    vi.mocked(getTransferFeeAmount).mockReturnValue(null as never);
  });

  it("scans SPL Token and Token-2022 and uses actual account lamports", async () => {
    const spl = makeAccount(TOKEN_PROGRAM_ID, 2_039_280);
    const token2022 = makeAccount(TOKEN_2022_PROGRAM_ID, 2_500_000);

    const connection = makeConnection([spl], [token2022]);
    const result = await scanWallet(wallet.toBase58(), connection);

    expect(connection.getTokenAccountsByOwner).toHaveBeenCalledTimes(2);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.program)).toEqual([
      "SPL Token",
      "Token-2022",
    ]);

    expect(result.rows.map((row) => row.status)).toEqual([
      "reclaimable",
      "reclaimable",
    ]);

    expect(result.rows.map((row) => row.lamports)).toEqual([
      BigInt(2_039_280),
      BigInt(2_500_000),
    ]);

    expect(result.walletLamports).toBe(BigInt(2_000_000_000));
    expect(result.contextSlot).toBe(110);
    expect(result.warnings).toBe(0);
  });

  it("rejects an account whose RPC owner does not match its token program", async () => {
    const wrongOwner = makeAccount(SystemProgram.programId, 1_000_000);
    const connection = makeConnection([wrongOwner], []);

    const result = await scanWallet(wallet.toBase58(), connection);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("scan_error");
    expect(result.rows[0].reasonCode).toBe("ACCOUNT_STATE_UNKNOWN");
    expect(result.rows[0].lamports).toBe(BigInt(1_000_000));
    expect(result.warnings).toBe(1);
    expect(unpackAccount).not.toHaveBeenCalled();
  });

  it("turns account decoding failures into scan_error rows", async () => {
    const account = makeAccount(TOKEN_PROGRAM_ID, 1_500_000);
    const connection = makeConnection([account], []);

    vi.mocked(unpackAccount).mockImplementation(() => {
      throw new Error("Malformed account data");
    });

    const result = await scanWallet(wallet.toBase58(), connection);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("scan_error");
    expect(result.rows[0].lamports).toBe(BigInt(1_500_000));
    expect(result.warnings).toBe(1);
  });

  it("rejects the scan if one of the required RPC requests fails", async () => {
    const connection = {
      getBalanceAndContext: vi.fn().mockResolvedValue({
        context: { slot: 120 },
        value: 1_000_000_000,
      }),
      getTokenAccountsByOwner: vi.fn()
        .mockResolvedValueOnce(makeResponse([], 115))
        .mockRejectedValueOnce(new Error("Token-2022 RPC unavailable")),
    } as unknown as Connection;

    await expect(
      scanWallet(wallet.toBase58(), connection),
    ).rejects.toThrow("Token-2022 RPC unavailable");
  });
});