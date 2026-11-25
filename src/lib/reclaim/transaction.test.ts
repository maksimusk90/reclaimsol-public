// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeCloseAccountInstruction,
  getTransferFeeAmount,
  unpackAccount,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  prepareCloseAccount,
  validatePreparedCloseAccount,
} from "./transaction";

vi.mock("@solana/spl-token", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@solana/spl-token")>();

  return {
    ...actual,
    unpackAccount: vi.fn(),
    getTransferFeeAmount: vi.fn(),
  };
});

const wallet = Keypair.generate().publicKey;
const account = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();

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
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash,
      lastValidBlockHeight: 123,
    }),
    getFeeForMessage: vi.fn().mockResolvedValue({
      context: { slot: 100 },
      value: 5_000,
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      context: { slot: 101 },
      value: {
        err: null,
        logs: ["simulation completed"],
        unitsConsumed: 25_000,
        returnData: null,
        accounts: null,
      },
    }),
  };
}

describe("prepareCloseAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(unpackAccount).mockReturnValue(parsedAccount as never);
    vi.mocked(getTransferFeeAmount).mockReturnValue(null);
  });

  it("prepares an unsigned SPL Token close transaction without simulation", async () => {
    const connection = createConnectionMock();

    const result = await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
    treasury.toBase58(),
      1500,
);

    expect(result.accountAddress).toBe(account.toBase58());
    expect(result.destinationAddress).toBe(wallet.toBase58());
    expect(result.tokenProgram).toBe("SPL Token");
    // Keep the transaction in legacy format so Phantom can inspect its existing Compute Budget instructions.
    expect(result.transaction.message.version).toBe("legacy");

    // Verify the actual compiled CloseAccount instruction.
    const decompiled = TransactionMessage.decompile(result.transaction.message);
    expect(decompiled.instructions).toHaveLength(4);

    const expectedPrice =
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 });
    const expectedLimit =
      ComputeBudgetProgram.setComputeUnitLimit({
        units: result.computeUnitLimit,
      });

    expect(decompiled.instructions[0].programId.equals(expectedPrice.programId)).toBe(true);
    expect(Buffer.from(decompiled.instructions[0].data).equals(expectedPrice.data)).toBe(true);
    expect(decompiled.instructions[1].programId.equals(expectedLimit.programId)).toBe(true);
    expect(Buffer.from(decompiled.instructions[1].data).equals(expectedLimit.data)).toBe(true);
    expect(decompiled.instructions[0].keys).toHaveLength(0);
    expect(decompiled.instructions[1].keys).toHaveLength(0);
    expect(result.computeUnitLimit).toBe(100_000);

    const decoded = decodeCloseAccountInstruction(
      decompiled.instructions[2],
      TOKEN_PROGRAM_ID,
    );

    expect(decoded.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(decoded.keys.account.pubkey.equals(account)).toBe(true);
    expect(decoded.keys.destination.pubkey.equals(wallet)).toBe(true);
    expect(decoded.keys.authority.pubkey.equals(wallet)).toBe(true);
    expect(decoded.keys.account.isWritable).toBe(true);
    expect(decoded.keys.destination.isWritable).toBe(true);
    expect(decoded.keys.authority.isSigner).toBe(true);
    expect(decoded.keys.multiSigners).toHaveLength(0);

    expect(result.rentLamports).toBe(BigInt(2_039_280));
    expect(result.estimatedNetworkFeeLamports).toBe(BigInt(5_000));

    expect(connection.getAccountInfo).toHaveBeenCalledWith(
      account,
      "confirmed",
    );
    expect(connection.simulateTransaction).not.toHaveBeenCalled();

    expect(
      result.transaction.signatures.every((signature) =>
        signature.every((byte) => byte === 0),
      ),
    ).toBe(true);

    expect(connection).not.toHaveProperty("sendTransaction");
  });

  it("adds the exact 15% service fee transfer after CloseAccount", async () => {
    const connection = createConnectionMock();

    const result = await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
      treasury.toBase58(),
      1500,
    );

    const decompiled = TransactionMessage.decompile(result.transaction.message);
    const transfer = decompiled.instructions[3];
    const expectedTransfer = SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: treasury,
      lamports: 305_892,
    });

    expect(result.serviceFeeBps).toBe(1500);
    expect(result.serviceFeeLamports).toBe(BigInt(305892));
    expect(result.estimatedNetRecoveredLamports).toBe(BigInt(1733388));
    expect(transfer.programId.equals(SystemProgram.programId)).toBe(true);
    expect(transfer.data).toEqual(expectedTransfer.data);
    expect(transfer.keys).toHaveLength(2);
    expect(transfer.keys[0].pubkey.equals(wallet)).toBe(true);
    expect(transfer.keys[1].pubkey.equals(treasury)).toBe(true);
    expect(transfer.keys[0].isSigner).toBe(true);
    expect(transfer.keys[0].isWritable).toBe(true);
    expect(transfer.keys[1].isWritable).toBe(true);

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects a prepared transaction with a treasury different from configuration", async () => {
    const connection = createConnectionMock();

    const prepared = await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
      treasury.toBase58(),
      1500,
    );

    const differentTreasury = Keypair.generate().publicKey.toBase58();

    expect(() =>
      validatePreparedCloseAccount(
        prepared,
        wallet.toBase58(),
        1500,
        differentTreasury,
      ),
    ).toThrow("Prepared transaction treasury validation failed.");
  });

  it("rejects a consistently modified fee rate and transfer", async () => {
    const connection = createConnectionMock();

    const prepared = await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
      treasury.toBase58(),
      1500,
    );

    expect(() =>
      validatePreparedCloseAccount(prepared, wallet.toBase58(), 1500, treasury.toBase58()),
    ).not.toThrow();

    const changedFee = (prepared.rentLamports * BigInt(1600)) / BigInt(10000);
    const decompiled = TransactionMessage.decompile(prepared.transaction.message);
    const changedInstructions = [...decompiled.instructions];

    changedInstructions[3] = SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: treasury,
      lamports: Number(changedFee),
    });

    const changedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: prepared.blockhash,
        instructions: changedInstructions,
      }).compileToV0Message(),
    );

    const changedPrepared = {
      ...prepared,
      serviceFeeBps: 1600,
      serviceFeeLamports: changedFee,
      estimatedNetRecoveredLamports: prepared.rentLamports - changedFee,
      transaction: changedTransaction,
    };

    expect(() =>
      validatePreparedCloseAccount(changedPrepared, wallet.toBase58(), 1500, treasury.toBase58()),
    ).toThrow("Prepared transaction fee validation failed.");
  });

  it("rejects a modified treasury transfer instruction", async () => {
    const connection = createConnectionMock();

    const prepared = await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
      treasury.toBase58(),
      1500,
    );

    const decompiled = TransactionMessage.decompile(prepared.transaction.message);
    const changedInstructions = [...decompiled.instructions];

    changedInstructions[3] = SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: treasury,
      lamports: Number(prepared.serviceFeeLamports + BigInt(1)),
    });

    const changedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: prepared.blockhash,
        instructions: changedInstructions,
      }).compileToV0Message(),
    );

    expect(() =>
      validatePreparedCloseAccount(
        { ...prepared, transaction: changedTransaction },
        wallet.toBase58(),
        1500,
        treasury.toBase58(),
      ),
    ).toThrow("Transaction contains unexpected instructions.");
  });

  it("rejects an account that no longer exists", async () => {
    const connection = createConnectionMock();
    connection.getAccountInfo.mockResolvedValue(null);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects an account owned by an unsupported program", async () => {
    const connection = createConnectionMock();
    connection.getAccountInfo.mockResolvedValue({
      executable: false,
      owner: Keypair.generate().publicKey,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROGRAM",
    });

    expect(unpackAccount).not.toHaveBeenCalled();
  });

  it("rejects an account with a non-zero token balance", async () => {
    const connection = createConnectionMock();

    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      amount: BigInt(1),
    } as never);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "ACCOUNT_NOT_EMPTY",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects when the connected wallet is not the close authority", async () => {
    const connection = createConnectionMock();

    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      owner: Keypair.generate().publicKey,
    } as never);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "AUTHORITY_MISMATCH",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });


  it("rejects Token-2022 accounts with withheld transfer fees", async () => {
    const connection = createConnectionMock();

    connection.getAccountInfo.mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      tlvData: Buffer.alloc(0),
    } as never);

    vi.mocked(getTransferFeeAmount).mockReturnValue({
      withheldAmount: BigInt(1),
    } as never);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "WITHHELD_FEES",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects Token-2022 accounts with an unknown extension", async () => {
    const connection = createConnectionMock();

    connection.getAccountInfo.mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    // TLV: extension type 999, data length 0.
    const unknownExtension = Buffer.from([
      0xe7, 0x03, 0x00, 0x00,
    ]);

    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      tlvData: unknownExtension,
    } as never);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_EXTENSION",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects Token-2022 accounts with an unsupported account extension", async () => {
    const connection = createConnectionMock();

    connection.getAccountInfo.mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    // PausableAccount (27) is known but not supported by the MVP.
    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      tlvData: Buffer.from([27, 0, 0, 0]),
    } as never);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_EXTENSION",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects Token-2022 accounts with malformed TLV data", async () => {
    const connection = createConnectionMock();

    connection.getAccountInfo.mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    // Type 999 declares 4 bytes but contains only 1.
    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      tlvData: Buffer.from([0xe7, 0x03, 0x04, 0x00, 0x01]),
    } as never);

    await expect(
      prepareCloseAccount(
        wallet.toBase58(),
        account.toBase58(),
        connection as unknown as Connection,
      treasury.toBase58(),
      1500,
),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_EXTENSION",
    });

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("prepares Token-2022 accounts with no withheld fees and no extensions", async () => {
    const connection = createConnectionMock();

    connection.getAccountInfo.mockResolvedValue({
      executable: false,
      owner: TOKEN_2022_PROGRAM_ID,
      lamports: 2_039_280,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    vi.mocked(unpackAccount).mockReturnValue({
      ...parsedAccount,
      tlvData: Buffer.alloc(0),
    } as never);

    vi.mocked(getTransferFeeAmount).mockReturnValue(null);

    const result = await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
    treasury.toBase58(),
      1500,
);

    expect(result.tokenProgram).toBe("Token-2022");

    const decompiled = TransactionMessage.decompile(result.transaction.message);
    expect(decompiled.instructions).toHaveLength(4);

    const decoded = decodeCloseAccountInstruction(
      decompiled.instructions[2],
      TOKEN_2022_PROGRAM_ID,
    );

    expect(decoded.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(decoded.keys.account.pubkey.equals(account)).toBe(true);
    expect(decoded.keys.destination.pubkey.equals(wallet)).toBe(true);
    expect(decoded.keys.authority.pubkey.equals(wallet)).toBe(true);
    expect(decoded.keys.account.isWritable).toBe(true);
    expect(decoded.keys.destination.isWritable).toBe(true);
    expect(decoded.keys.authority.isSigner).toBe(true);
    expect(decoded.keys.multiSigners).toHaveLength(0);

    expect(result.rentLamports).toBe(BigInt(2_039_280));
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
    expect(
      result.transaction.signatures.every((signature) =>
        signature.every((byte) => byte === 0),
      ),
    ).toBe(true);
  });

  it("does not call simulateTransaction during preparation", async () => {
    const connection = createConnectionMock();

    await prepareCloseAccount(
      wallet.toBase58(),
      account.toBase58(),
      connection as unknown as Connection,
      treasury.toBase58(),
      1500,
    );

    expect(connection.simulateTransaction).not.toHaveBeenCalled();
    expect(connection.getFeeForMessage).toHaveBeenCalledTimes(1);
  });

});