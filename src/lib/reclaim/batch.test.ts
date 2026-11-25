// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  decodeHarvestWithheldTokensToMintInstruction,
  decodeBurnCheckedInstruction,
  getTransferFeeAmount,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { Connection, Keypair, TransactionMessage } from "@solana/web3.js";

import {
  planCloseAccountBatches,
  prepareCloseAccountBatch,
  refreshPreparedCloseBatchForSigning,
  validatePreparedCloseBatch,
} from "./batch";

vi.mock("@solana/spl-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/spl-token")>();

  return {
    ...actual,
    unpackAccount: vi.fn(),
    getTransferFeeAmount: vi.fn(),
    getTransferFeeConfig: vi.fn(),
    unpackMint: vi.fn(),
  };
});

const wallet = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const addresses = Array.from({ length: 15 }, () => Keypair.generate().publicKey);

const parsedAccount = {
  mint: Keypair.generate().publicKey,
  owner: wallet,
  amount: BigInt(0),
  isNative: false,
  isFrozen: false,
  isInitialized: true,
  closeAuthority: null,
  tlvData: Buffer.alloc(0),
};

function createConnectionMock() {
  return {
    getAccountInfo: vi.fn().mockResolvedValue({
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    }),
    getLatestBlockhash: vi.fn(),
    simulateTransaction: vi.fn().mockResolvedValue({
      context: { slot: 100 },
      value: { err: null, unitsConsumed: 80_000, logs: [] },
    }),
    getFeeForMessage: vi.fn().mockResolvedValue({
      context: { slot: 100 },
      value: 5_000,
    }),
  };
}

describe("batch planning and preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(unpackAccount).mockReturnValue(parsedAccount as never);
    vi.mocked(getTransferFeeAmount).mockReturnValue(null);
    vi.mocked(getTransferFeeConfig).mockReturnValue(null);
  });

  it("splits selected accounts into groups without losing or duplicating any", async () => {
    const connection = createConnectionMock();

    const groups = await planCloseAccountBatches({
      walletAddress: wallet.toBase58(),
      accountAddresses: addresses.map((address) => address.toBase58()),
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    });

    expect(groups.length).toBeGreaterThan(1);

    const plannedAddresses = groups.flat().map((account) => account.address);

    expect(plannedAddresses.sort()).toEqual(addresses.map((address) => address.toBase58()).sort());
    expect(new Set(plannedAddresses).size).toBe(addresses.length);
    expect(groups.every((group) => group.length <= 8)).toBe(true);
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it("bounds concurrent account inspection while accelerating large selections", async () => {
    const connection = createConnectionMock();
    let active = 0;
    let maximumActive = 0;
    vi.mocked(connection.getAccountInfo).mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return {
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2_039_280,
        data: Buffer.alloc(0),
        rentEpoch: 0,
      } as never;
    });

    await planCloseAccountBatches({
      walletAddress: wallet.toBase58(),
      accountAddresses: addresses.map((address) => address.toBase58()),
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    });

    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it("enforces the eight-account transaction ceiling without limiting total batches", async () => {
    const connection = createConnectionMock();
    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: addresses.map((address) => address.toBase58()),
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };

    const groups = await planCloseAccountBatches(config);
    expect(groups.map((group) => group.length)).toEqual([8, 7]);
    expect(groups.flat()).toHaveLength(15);

    await expect(prepareCloseAccountBatch(config, groups.flat(), 0)).rejects.toThrow(
      /cannot contain more than 8 token accounts/i,
    );
  });

  it("gets a fresh blockhash and re-reads accounts for each batch", async () => {
    const connection = createConnectionMock();
    const blockhashes = Array.from({ length: 30 }, () => Keypair.generate().publicKey.toBase58());
    let blockhashIndex = 0;

    vi.mocked(connection.getLatestBlockhash).mockImplementation(async () => ({
      blockhash: blockhashes[blockhashIndex++],
      lastValidBlockHeight: 500 + blockhashIndex,
    }));

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: addresses.map((address) => address.toBase58()),
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };

    const groups = await planCloseAccountBatches(config);
    const readsAfterPlanning = connection.getAccountInfo.mock.calls.length;
    const prepared = [];

    for (let index = 0; index < groups.length; index += 1) {
      prepared.push(await prepareCloseAccountBatch(config, groups[index], index));
    }

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(groups.length * 2);
    expect(connection.getAccountInfo.mock.calls.length).toBeGreaterThan(readsAfterPlanning);
    expect(prepared.map((batch) => batch.blockhash)).toEqual(
      groups.map((_, index) => blockhashes[index * 2 + 1]),
    );
    expect(new Set(prepared.map((batch) => batch.blockhash)).size).toBe(groups.length);
    expect(prepared.every((batch) => batch.serializedSizeBytes <= 1232)).toBe(true);
    expect(prepared.every((batch) => batch.transaction.message.version === "legacy")).toBe(true);
  });

  it("refreshes the blockhash after the review step and revalidates account state", async () => {
    const connection = createConnectionMock();
    const blockhashes = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());
    let blockhashIndex = 0;
    vi.mocked(connection.getLatestBlockhash).mockImplementation(async () => ({
      blockhash: blockhashes[blockhashIndex++],
      lastValidBlockHeight: 900 + blockhashIndex,
    }));

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const reviewed = await prepareCloseAccountBatch(config, groups[0], 0);
    const readsBeforeRefresh = connection.getAccountInfo.mock.calls.length;
    const signing = await refreshPreparedCloseBatchForSigning(config, reviewed);

    expect(signing.blockhash).toBe(blockhashes[2]);
    expect(signing.blockhash).not.toBe(reviewed.blockhash);
    expect(signing.transaction.message.recentBlockhash).toBe(blockhashes[2]);
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(3);
    expect(connection.getAccountInfo.mock.calls.length).toBeGreaterThan(readsBeforeRefresh);
    expect(() => validatePreparedCloseBatch(signing, wallet.toBase58(), 1500, treasury.toBase58())).not.toThrow();
  });

  it("refuses to sign when an account changes after the user reviewed the batch", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 950,
    });
    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const reviewed = await prepareCloseAccountBatch(config, groups[0], 0);
    vi.mocked(connection.getAccountInfo).mockResolvedValue({
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      lamports: 2_039_281,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    } as never);

    await expect(refreshPreparedCloseBatchForSigning(config, reviewed)).rejects.toThrow(/changed after review/i);
  });

  it("requires explicit harvest consent when withheld fees are found during planning", async () => {
    const connection = createConnectionMock();
    const mint = Keypair.generate().publicKey;
    const tlv = Buffer.alloc(12);
    tlv.writeUInt16LE(ExtensionType.TransferFeeAmount, 0);
    tlv.writeUInt16LE(8, 2);
    vi.mocked(connection.getAccountInfo).mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    } as never);
    vi.mocked(unpackAccount).mockReturnValue({ ...parsedAccount, mint, tlvData: tlv } as never);
    vi.mocked(getTransferFeeAmount).mockReturnValue({ withheldAmount: BigInt(1) } as never);
    vi.mocked(unpackMint).mockReturnValue({} as never);
    vi.mocked(getTransferFeeConfig).mockReturnValue({} as never);

    await expect(
      planCloseAccountBatches({
        walletAddress: wallet.toBase58(),
        accountAddresses: [addresses[0].toBase58()],
        connection: connection as unknown as Connection,
        treasuryAddress: treasury.toBase58(),
        serviceFeeBps: 1500,
      }),
    ).rejects.toMatchObject({ code: "WITHHELD_FEES_CONSENT_REQUIRED" });
  });

  it("adds a permissionless harvest instruction before closing a Token-2022 account with withheld fees", async () => {
    const connection = createConnectionMock();
    const mint = Keypair.generate().publicKey;
    const account = addresses[0];
    const tlv = Buffer.alloc(12);
    tlv.writeUInt16LE(ExtensionType.TransferFeeAmount, 0);
    tlv.writeUInt16LE(8, 2);
    vi.mocked(connection.getAccountInfo).mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    } as never);
    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      mint,
      tlvData: tlv,
    } as never);
    vi.mocked(getTransferFeeAmount).mockReturnValue({ withheldAmount: BigInt(42) } as never);
    vi.mocked(unpackMint).mockReturnValue({} as never);
    vi.mocked(getTransferFeeConfig).mockReturnValue({} as never);
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 800,
    });

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [account.toBase58()],
      harvestAccountAddresses: [account.toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);
    const decompiled = TransactionMessage.decompile(prepared.transaction.message);

    expect(decompiled.instructions).toHaveLength(5);
    const harvest = decodeHarvestWithheldTokensToMintInstruction(
      decompiled.instructions[2],
      TOKEN_2022_PROGRAM_ID,
    );
    expect(harvest.keys.mint.pubkey.equals(mint)).toBe(true);
    expect(harvest.keys.sources).toHaveLength(1);
    expect(harvest.keys.sources?.[0]?.pubkey.equals(account)).toBe(true);
    expect(prepared.accounts[0].withheldAmount).toBe(BigInt(42));
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(() =>
      validatePreparedCloseBatch(prepared, wallet.toBase58(), 1500, treasury.toBase58()),
    ).not.toThrow();
  });

  it("requires explicit burn consent for a non-zero token account", async () => {
    const connection = createConnectionMock();
    vi.mocked(unpackAccount).mockReturnValue({ ...parsedAccount, amount: BigInt(12) } as never);
    vi.mocked(unpackMint).mockReturnValue({ decimals: 6 } as never);
    await expect(
      planCloseAccountBatches({
        walletAddress: wallet.toBase58(),
        accountAddresses: [addresses[0].toBase58()],
        connection: connection as unknown as Connection,
        treasuryAddress: treasury.toBase58(),
        serviceFeeBps: 1500,
      }),
    ).rejects.toMatchObject({ code: "BURN_CONSENT_REQUIRED" });
  });

  it("burns the full SPL balance with BurnChecked before closing and fee transfer", async () => {
    const connection = createConnectionMock();
    const mint = parsedAccount.mint;
    const account = addresses[0];
    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      mint,
      amount: BigInt(1234567),
    } as never);
    vi.mocked(unpackMint).mockReturnValue({ decimals: 6 } as never);
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 810,
    });
    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [account.toBase58()],
      burnAccountAddresses: [account.toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);
    const decompiled = TransactionMessage.decompile(prepared.transaction.message);
    expect(decompiled.instructions).toHaveLength(5);
    const burn = decodeBurnCheckedInstruction(decompiled.instructions[2], TOKEN_PROGRAM_ID);
    expect(burn.keys.account.pubkey.equals(account)).toBe(true);
    expect(burn.keys.mint.pubkey.equals(mint)).toBe(true);
    expect(burn.keys.owner.pubkey.equals(wallet)).toBe(true);
    expect(burn.data.amount).toBe(BigInt(1234567));
    expect(burn.data.decimals).toBe(6);
    expect(prepared.accounts[0].tokenAmount).toBe(BigInt(1234567));
    expect(() =>
      validatePreparedCloseBatch(prepared, wallet.toBase58(), 1500, treasury.toBase58()),
    ).not.toThrow();
    expect(() => validatePreparedCloseBatch({
      ...prepared,
      accounts: prepared.accounts.map((item) => ({ ...item, tokenAmount: BigInt(0) })),
    }, wallet.toBase58(), 1500, treasury.toBase58())).toThrow(/unexpected transaction instructions/i);
  });

  it("harvests withheld fees, burns the Token-2022 balance, then closes atomically", async () => {
    const connection = createConnectionMock();
    const mint = Keypair.generate().publicKey;
    const account = addresses[1];
    const tlv = Buffer.alloc(12);
    tlv.writeUInt16LE(ExtensionType.TransferFeeAmount, 0);
    tlv.writeUInt16LE(8, 2);
    vi.mocked(connection.getAccountInfo).mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    } as never);
    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      mint,
      amount: BigInt(5000),
      tlvData: tlv,
    } as never);
    vi.mocked(getTransferFeeAmount).mockReturnValue({ withheldAmount: BigInt(42) } as never);
    vi.mocked(unpackMint).mockReturnValue({ decimals: 2 } as never);
    vi.mocked(getTransferFeeConfig).mockReturnValue({} as never);
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 811,
    });
    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [account.toBase58()],
      harvestAccountAddresses: [account.toBase58()],
      burnAccountAddresses: [account.toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);
    const instructions = TransactionMessage.decompile(prepared.transaction.message).instructions;
    expect(instructions).toHaveLength(6);
    expect(
      decodeHarvestWithheldTokensToMintInstruction(
        instructions[2],
        TOKEN_2022_PROGRAM_ID,
      ).keys.mint.pubkey.equals(mint),
    ).toBe(true);
    const burn = decodeBurnCheckedInstruction(instructions[3], TOKEN_2022_PROGRAM_ID);
    expect(burn.data.amount).toBe(BigInt(5000));
    expect(burn.data.decimals).toBe(2);
    expect(burn.keys.account.pubkey.equals(account)).toBe(true);
    expect(() =>
      validatePreparedCloseBatch(prepared, wallet.toBase58(), 1500, treasury.toBase58()),
    ).not.toThrow();
  });

  it("rejects an account whose token balance changes after selection", async () => {
    const connection = createConnectionMock();
    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      burnAccountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };

    const groups = await planCloseAccountBatches(config);

    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      amount: BigInt(1),
    } as never);
    vi.mocked(unpackMint).mockReturnValue({ decimals: 0 } as never);

    await expect(prepareCloseAccountBatch(config, groups[0], 0)).rejects.toMatchObject({
      code: "TOKEN_BALANCE_CHANGED",
    });

    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it("rejects a prepared batch with an unknown token program", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 600,
    });

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);
    const tampered = {
      ...prepared,
      accounts: prepared.accounts.map((account) => ({
        ...account,
        tokenProgram: "unexpected-program" as never,
      })),
    };

    expect(() =>
      validatePreparedCloseBatch(tampered, wallet.toBase58(), 1500, treasury.toBase58()),
    ).toThrow(/unsupported token program/i);
  });

  it("rejects invalid prepared batch metadata", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 600,
    });

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);

    expect(() =>
      validatePreparedCloseBatch(
        { ...prepared, lastValidBlockHeight: Number.NaN },
        wallet.toBase58(),
        1500,
        treasury.toBase58(),
      ),
    ).toThrow(/invalid transaction metadata/i);
  });

  it("uses measured compute usage with a 20 percent safety margin", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 700,
    });
    vi.mocked(connection.simulateTransaction).mockResolvedValue({
      context: { slot: 100 },
      value: { err: null, unitsConsumed: 80_000, logs: [] },
    } as never);

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);

    expect(prepared.simulatedComputeUnits).toBe(80_000);
    expect(prepared.computeUnitLimit).toBe(96_000);
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(connection.getFeeForMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks preparation when RPC simulation reports an instruction error", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 701,
    });
    vi.mocked(connection.simulateTransaction).mockResolvedValue({
      context: { slot: 100 },
      value: {
        err: { InstructionError: [0, "Custom"] },
        unitsConsumed: 80_000,
        logs: ["Program failed"],
      },
    } as never);

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);

    await expect(prepareCloseAccountBatch(config, groups[0], 0)).rejects.toMatchObject({
      code: "SIMULATION_FAILED",
      logs: ["Program failed"],
    });
    expect(connection.getFeeForMessage).not.toHaveBeenCalled();
  });

  it("blocks preparation when RPC does not return compute usage", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 702,
    });
    vi.mocked(connection.simulateTransaction).mockResolvedValue({
      context: { slot: 100 },
      value: { err: null, unitsConsumed: null, logs: [] },
    } as never);

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);

    await expect(prepareCloseAccountBatch(config, groups[0], 0)).rejects.toMatchObject({
      code: "COMPUTE_UNITS_UNAVAILABLE",
    });
    expect(connection.getFeeForMessage).not.toHaveBeenCalled();
  });

  it("rejects measured compute usage above the maximum after safety margin", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 703,
    });
    vi.mocked(connection.simulateTransaction).mockResolvedValue({
      context: { slot: 100 },
      value: { err: null, unitsConsumed: 1_200_001, logs: [] },
    } as never);

    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);

    await expect(prepareCloseAccountBatch(config, groups[0], 0)).rejects.toThrow(
      /maximum compute-unit budget/i,
    );
    expect(connection.getFeeForMessage).not.toHaveBeenCalled();
  });

  it("rejects prepared metadata that removes the measured compute safety margin", async () => {
    const connection = createConnectionMock();
    vi.mocked(connection.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 704,
    });
    const config = {
      walletAddress: wallet.toBase58(),
      accountAddresses: [addresses[0].toBase58()],
      connection: connection as unknown as Connection,
      treasuryAddress: treasury.toBase58(),
      serviceFeeBps: 1500,
    };
    const groups = await planCloseAccountBatches(config);
    const prepared = await prepareCloseAccountBatch(config, groups[0], 0);

    expect(() =>
      validatePreparedCloseBatch(
        { ...prepared, computeUnitLimit: 80_000 },
        wallet.toBase58(),
        1500,
        treasury.toBase58(),
      ),
    ).toThrow(/prepared batch validation failed/i);
  });
});