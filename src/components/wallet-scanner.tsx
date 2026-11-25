"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey } from "@solana/web3.js";
import {
  formatLamports,
  scanWallet,
} from "@/lib/reclaim/scanner";
import type {
  ScanResult,
  ScanRow,
} from "@/lib/reclaim/types";
import {
  ClosePreparationError,
  prepareCloseAccount,
  validatePreparedCloseAccount,
} from "@/lib/reclaim/transaction";
import type {
  PreparedCloseAccount,
} from "@/lib/reclaim/transaction";
import {
  getSignedTransactionSignature,
  inspectTransactionOutcome,
} from "@/lib/reclaim/execution";
import {
  createPendingTransaction,
  readPendingTransactions,
  removePendingTransaction,
  savePendingTransactions,
} from "@/lib/reclaim/pending";
import type { PendingTransaction } from "@/lib/reclaim/pending";
import {
  groupPendingTransactions,
  resolvePendingTransactionGroup,
} from "@/lib/reclaim/pending-recovery";

type ExecutionUiState =
  | {
      status: "sending";
      walletAddress: string;
      accountAddress: string;
    }
  | {
      status: "confirmed";
      walletAddress: string;
      accountAddress: string;
      signature: string;
      grossRecoveredLamports: bigint | null;
      serviceFeeLamports: bigint | null;
      netRecoveredLamports: bigint | null;
      networkFeeLamports: bigint | null;
      verificationWarning?: string;
    }
  | {
      status: "unknown";
      walletAddress: string;
      accountAddress: string;
      signature: string;
      message: string;
    }
  | {
      status: "error";
      walletAddress: string;
      accountAddress: string;
      message: string;
      signature?: string;
    };

type PreparationUiState =
  | {
      status: "preparing";
      walletAddress: string;
      accountAddress: string;
    }
  | {
      status: "success";
      walletAddress: string;
      accountAddress: string;
      prepared: PreparedCloseAccount;
    }
  | {
      status: "error";
      walletAddress: string;
      accountAddress: string;
      message: string;
      logs: string[];
    };

function shortAddress(value: string | null): string {
  if (!value) return "—";
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

function statusLabel(row: ScanRow): string {
  switch (row.status) {
    case "reclaimable":
      return "Eligible";
    case "has_tokens":
      return "Contains tokens";
    case "review_required":
      return "Review required";
    case "unsupported":
      return "Unsupported";
    case "scan_error":
      return "Scan error";
  }
}

function rpcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/\b429\b|rate.?limit|too many requests/i.test(message)) {
    return "The Solana RPC rate limit was reached. Wait briefly and scan again.";
  }

  if (/\b403\b|forbidden/i.test(message)) {
    return "The selected Solana RPC endpoint denied the request.";
  }

  return "The wallet scan failed. Check the network connection and try again.";
}

function preparationErrorMessage(error: unknown): {
  message: string;
  logs: string[];
} {
  if (error instanceof ClosePreparationError) {
    return {
      message: error.message,
      logs: error.logs,
    };
  }

  return {
    message:
      "Could not prepare the transaction. Check the RPC connection and try again.",
    logs: [],
  };
}

export function WalletScanner() {
  const { connection } = useConnection();
  const { connected, publicKey, signTransaction } = useWallet();

  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedWallet, setScannedWallet] = useState<string | null>(null);
  const [preparation, setPreparation] =
    useState<PreparationUiState | null>(null);
  const [preparingAccount, setPreparingAccount] =
    useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionUiState | null>(null);
  const [executingAccount, setExecutingAccount] = useState<string | null>(null);

  const [pendingTransactions, setPendingTransactions] =
    useState<PendingTransaction[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [pendingStorageError, setPendingStorageError] =
    useState<string | null>(null);
  const [recheckingPending, setRecheckingPending] = useState(false);

  const preparingAccountRef = useRef<string | null>(null);
  const executingAccountRef = useRef<string | null>(null);
  const pendingRecheckRef = useRef(false);

  const walletAddress = publicKey?.toBase58() ?? null;
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet";
  const readOnlyMode = process.env.NEXT_PUBLIC_RECLAIMSOL_READ_ONLY === "true";

  useEffect(() => {
    let active = true;

    // Defer localStorage hydration until after the effect commits.
    // Pending records are global to this browser profile, not wallet-specific.
    void Promise.resolve().then(() => {
      if (!active) return;

      try {
        const records = readPendingTransactions(window.localStorage);
        setPendingTransactions(records);
        setPendingStorageError(null);
      } catch (storageError) {
        setPendingStorageError(
          storageError instanceof Error
            ? storageError.message
            : "Pending transaction storage cannot be read. Recovery is blocked.",
        );
      } finally {
        setPendingLoaded(true);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const walletPendingTransactions = pendingTransactions.filter(
    (item) =>
      item.network === network &&
      item.walletAddress === walletAddress,
  );

  const visiblePreparation =
    preparation?.walletAddress === walletAddress
      ? preparation
      : null;

  const summary = useMemo(() => {
    if (!result || scannedWallet !== walletAddress) return null;

    const eligible = result.rows.filter(
      (row) => row.status === "reclaimable",
    );

    const review = result.rows.filter(
      (row) =>
        row.status === "review_required" ||
        row.status === "unsupported" ||
        row.status === "scan_error",
    );

    const hasTokens = result.rows.filter(
      (row) => row.status === "has_tokens",
    );

    const grossLamports = eligible.reduce(
      (total, row) => total + row.lamports,
      BigInt(0),
    );

    return {
      eligibleCount: eligible.length,
      reviewCount: review.length,
      hasTokensCount: hasTokens.length,
      grossLamports,
    };
  }, [result, scannedWallet, walletAddress]);

  async function handleRecheckPending() {
    if (
      !walletAddress ||
      !pendingLoaded ||
      pendingStorageError ||
      recheckingPending ||
      pendingRecheckRef.current ||
      preparingAccountRef.current ||
      executingAccountRef.current
    ) {
      return;
    }

    pendingRecheckRef.current = true;
    setRecheckingPending(true);
    setError(null);

    try {
      const current = readPendingTransactions(window.localStorage);
      const matching = current.filter(
        (item) =>
          item.network === network &&
          item.walletAddress === walletAddress,
      );

      const groups = groupPendingTransactions(matching);

      for (const group of groups) {
        await resolvePendingTransactionGroup(
          window.localStorage,
          group,
          (signature) => inspectTransactionOutcome(connection, signature),
          (accountAddress) =>
            connection.getAccountInfo(
              new PublicKey(accountAddress),
              "confirmed",
            ),
        );
      }

      setPendingTransactions(readPendingTransactions(window.localStorage));
    } catch (recheckError) {
      setError(
        recheckError instanceof Error
          ? `Could not safely resolve pending transactions: ${recheckError.message}`
          : "Could not safely resolve pending transactions. The account remains blocked.",
      );
    } finally {
      pendingRecheckRef.current = false;
      setRecheckingPending(false);
    }
  }

  async function handleScan() {
    if (
      !connected ||
      !walletAddress ||
      scanning ||
      preparingAccountRef.current ||
      executingAccountRef.current
    ) {
      return;
    }

    setScanning(true);
    setError(null);
    setResult(null);
    setScannedWallet(null);
    setPreparation(null);

    try {
      const nextResult = await scanWallet(walletAddress, connection);

      if (publicKey?.toBase58() === walletAddress) {
        setResult(nextResult);
        setScannedWallet(walletAddress);
      }
    } catch (scanError) {
      if (publicKey?.toBase58() === walletAddress) {
        setError(rpcErrorMessage(scanError));
      }
    } finally {
      setScanning(false);
    }
  }

  async function handlePrepare(row: ScanRow) {
    if (
      readOnlyMode ||
      !connected ||
      !walletAddress ||
      row.status !== "reclaimable" ||
      scannedWallet !== walletAddress ||
      scanning ||
      preparingAccountRef.current ||
      executingAccountRef.current ||
      pendingRecheckRef.current ||
      !pendingLoaded ||
      pendingStorageError ||
      pendingTransactions.some(
        (item) =>
          item.network === network &&
          item.walletAddress === walletAddress &&
          item.accountAddress === row.address,
      )
    ) {
      return;
    }

    preparingAccountRef.current = row.address;
    setPreparingAccount(row.address);

    setPreparation({
      status: "preparing",
      walletAddress,
      accountAddress: row.address,
    });

    try {
      const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
      const feeBpsValue =
        process.env.NEXT_PUBLIC_RECLAIMSOL_SERVICE_FEE_BPS;

      if (!treasuryAddress) {
        throw new Error("Service treasury address is not configured.");
      }

      if (
        !feeBpsValue ||
        !/^\d+$/.test(feeBpsValue)
      ) {
        throw new Error("Service fee configuration is missing or invalid.");
      }

      const serviceFeeBps = Number(feeBpsValue);

      if (
        !Number.isSafeInteger(serviceFeeBps) ||
        serviceFeeBps < 1 ||
        serviceFeeBps >= 10_000
      ) {
        throw new Error("Service fee must be between 1 and 9999 basis points.");
      }

      const prepared = await prepareCloseAccount(
        walletAddress,
        row.address,
        connection,
        treasuryAddress,
        serviceFeeBps,
      );

      // Do not display a result for a wallet that changed during preparation.
      if (publicKey?.toBase58() !== walletAddress) {
        return;
      }

      setPreparation({
        status: "success",
        walletAddress,
        accountAddress: row.address,
        prepared,
      });
    } catch (prepareError) {
      if (publicKey?.toBase58() !== walletAddress) {
        return;
      }

      const details = preparationErrorMessage(prepareError);

      setPreparation({
        status: "error",
        walletAddress,
        accountAddress: row.address,
        message: details.message,
        logs: details.logs,
      });
    } finally {
      preparingAccountRef.current = null;
      setPreparingAccount(null);
    }
  }

  function clearPendingRecord(
    item: Pick<
      PendingTransaction,
      "network" | "walletAddress" | "accountAddress" | "signature"
    >,
  ): boolean {
    try {
      removePendingTransaction(
        window.localStorage,
        item.network,
        item.walletAddress,
        item.accountAddress,
        item.signature,
      );
      setPendingTransactions((current) =>
        current.filter(
          (record) =>
            !(
              record.network === item.network &&
              record.walletAddress === item.walletAddress &&
              record.accountAddress === item.accountAddress &&
              record.signature === item.signature
            ),
        ),
      );
      setPendingStorageError(null);
      return true;
    } catch (storageError) {
      setPendingStorageError(
        storageError instanceof Error
          ? storageError.message
          : "Could not update pending transaction storage. Recovery remains blocked.",
      );
      return false;
    }
  }

  async function handleExecute(prepared: PreparedCloseAccount) {
    if (
      readOnlyMode ||
      !connected ||
      !publicKey ||
      !walletAddress ||
      prepared.destinationAddress !== walletAddress ||
      !prepared.accountAddress ||
      executingAccountRef.current ||
      preparingAccountRef.current ||
      pendingRecheckRef.current ||
      !pendingLoaded ||
      Boolean(pendingStorageError) ||
      pendingTransactions.some(
        (item) =>
          item.network === network &&
          item.walletAddress === walletAddress &&
          item.accountAddress === prepared.accountAddress,
      )
    ) {
      return;
    }

    const accountAddress = prepared.accountAddress;
    executingAccountRef.current = accountAddress;
    setExecutingAccount(accountAddress);
    setExecution({ status: "sending", walletAddress, accountAddress });

    let signature: string | undefined;
    let sendAttempted = false;
    let transactionConfirmed = false;

    try {
      // Ставка и адрес казначейства берутся из публичной конфигурации.
      const expectedServiceFeeBps = Number(
        process.env.NEXT_PUBLIC_RECLAIMSOL_SERVICE_FEE_BPS,
      );
      const expectedTreasuryAddress =
        process.env.NEXT_PUBLIC_TREASURY_ADDRESS;

      if (!expectedTreasuryAddress) {
        throw new Error("Service treasury address is not configured.");
      }

      // Проверяем, что Phantom подпишет именно ожидаемую операцию.
      validatePreparedCloseAccount(
        prepared,
        walletAddress,
        expectedServiceFeeBps,
        expectedTreasuryAddress,
      );

      const currentBlockHeight = await connection.getBlockHeight("confirmed");

      if (currentBlockHeight > prepared.lastValidBlockHeight) {
        throw new Error("Transaction expired. Prepare a new transaction and try again.");
      }

      // Отдельно подписываем транзакцию. На этом этапе отправки в сеть нет.
      if (typeof signTransaction !== "function") {
        throw new Error(
          "This wallet does not support separate transaction signing.",
        );
      }

      const signedTransaction = await signTransaction(prepared.transaction);

      // Запрещаем любые изменения сообщения при подписании.
      const originalMessage = prepared.transaction.message.serialize();
      const signedMessage = signedTransaction.message.serialize();

      const messageUnchanged =
        originalMessage.length === signedMessage.length &&
        originalMessage.every(
          (byte, index) => byte === signedMessage[index],
        );

      if (!messageUnchanged) {
        console.error("[ReclaimSOL] Wallet modified the transaction message.");
        throw new Error("Wallet modified the transaction. Not sent.");
      }

      // Повторно проверяем именно подписанную транзакцию.
      validatePreparedCloseAccount(
        { ...prepared, transaction: signedTransaction },
        walletAddress,
        expectedServiceFeeBps,
        expectedTreasuryAddress,
      );

      // Проверяем Ed25519-подпись подключённого кошелька.
      // validatePreparedCloseAccount выше подтверждает, что это
      // единственный обязательный подписант данной транзакции.
      const requiredSignatures =
        signedTransaction.message.header.numRequiredSignatures;

      if (
        requiredSignatures !== 1 ||
        signedTransaction.signatures.length !== 1
      ) {
        throw new Error(
          "Unexpected transaction signer count. Transaction was not sent.",
        );
      }

      const walletSignature = signedTransaction.signatures[0];

      let signatureIsValid = false;

      try {
        signatureIsValid =
          walletSignature.length === 64 &&
          ed25519.verify(
            walletSignature,
            signedMessage,
            new PublicKey(walletAddress).toBytes(),
            { zip215: false },
          );
      } catch {
        signatureIsValid = false;
      }

      if (!signatureIsValid) {
        throw new Error(
          "Transaction signature verification failed. Transaction was not sent.",
        );
      }

      // Сигнатура известна до RPC-отправки. Даже если RPC потеряет ответ,
      // мы сможем проверить судьбу именно этой транзакции.
      signature = getSignedTransactionSignature(signedTransaction);

      // Проверяем срок действия непосредственно перед отправкой.
      const signingBlockHeight =
        await connection.getBlockHeight("confirmed");

      if (signingBlockHeight > prepared.lastValidBlockHeight) {
        throw new Error(
          "Transaction expired after signing. Prepare a new transaction and try again.",
        );
      }

      // Сохраняем подпись до отправки. Если запись не сохранена,
      // транзакция не должна попасть в RPC.
      try {
        savePendingTransactions(window.localStorage, [
          createPendingTransaction({
            network,
            walletAddress,
            accountAddress,
            signature,
          }),
        ]);
        setPendingTransactions(readPendingTransactions(window.localStorage));
      } catch (storageError) {
        setPendingStorageError(
          storageError instanceof Error
            ? storageError.message
            : "Pending transaction storage is unavailable.",
        );
        throw new Error(
          "The transaction was NOT sent because its recovery record could not be saved.",
        );
      }

      // После этой строки RPC мог получить транзакцию даже при сетевой ошибке.
      sendAttempted = true;

      // Только теперь отправляем проверенную подписанную транзакцию в RPC.
      const rpcSignature = await connection.sendRawTransaction(
        signedTransaction.serialize(),
        {
          preflightCommitment: "confirmed",
          maxRetries: 3,
        },
      );

      if (rpcSignature !== signature) {
        throw new Error(
          "RPC returned a signature different from the locally verified transaction signature.",
        );
      }

      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        },
        "confirmed",
      );

      if (confirmation.value.err !== null) {
        throw new Error(
          `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }

      // С этого момента транзакция подтверждена успешно.
      // Последующие ошибки проверки метаданных не должны разрешать повтор.
      transactionConfirmed = true;

      // Проверяем, что аккаунт действительно закрыт.
      const remainingAccount = await connection.getAccountInfo(
        new PublicKey(accountAddress),
        "confirmed",
      );

      if (remainingAccount !== null) {
        throw new Error(
          "Transaction was confirmed, but the token account still exists. Check the signature.",
        );
      }

      // Подтверждённая транзакция закрыла аккаунт — снимаем локальную блокировку.
      // При ошибке localStorage запись остаётся, а операции блокируются.
      clearPendingRecord({
        network,
        walletAddress,
        accountAddress,
        signature,
      });

      // Получаем фактические изменения баланса из подтверждённой транзакции.
      const confirmedTransaction = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      let grossRecoveredLamports: bigint | null = null;
      let serviceFeeLamports: bigint | null = null;
      let netRecoveredLamports: bigint | null = null;
      let networkFeeLamports: bigint | null = null;

      if (
        confirmedTransaction?.meta &&
        confirmedTransaction.meta.err === null
      ) {
        const meta = confirmedTransaction.meta;
        const accountKeys =
          confirmedTransaction.transaction.message.staticAccountKeys;

        const walletIndex = accountKeys.findIndex(
          (key) => key.toBase58() === walletAddress,
        );
        const treasuryIndex = accountKeys.findIndex(
          (key) => key.toBase58() === prepared.treasuryAddress,
        );

        const balancesAvailable =
          walletIndex >= 0 &&
          treasuryIndex >= 0 &&
          meta.preBalances[walletIndex] !== undefined &&
          meta.postBalances[walletIndex] !== undefined &&
          meta.preBalances[treasuryIndex] !== undefined &&
          meta.postBalances[treasuryIndex] !== undefined;

        if (!balancesAvailable) {
          throw new Error(
            "Transaction confirmed, but wallet or treasury balance changes could not be verified.",
          );
        }

        const walletDelta =
          BigInt(meta.postBalances[walletIndex]) -
          BigInt(meta.preBalances[walletIndex]);

        const treasuryDelta =
          BigInt(meta.postBalances[treasuryIndex]) -
          BigInt(meta.preBalances[treasuryIndex]);

        const actualServiceFee = prepared.serviceFeeLamports;
        const actualNetworkFee = BigInt(meta.fee);

        if (treasuryDelta !== actualServiceFee) {
          throw new Error(
            "Transaction confirmed, but the treasury balance change does not match the prepared service fee.",
          );
        }

        const grossRecovered =
          walletDelta + treasuryDelta + actualNetworkFee;

        const netRecovered = grossRecovered - actualServiceFee;

        if (
          grossRecovered < actualServiceFee ||
          netRecovered < BigInt(0)
        ) {
          throw new Error(
            "Transaction confirmed, but the recovered amount failed balance verification.",
          );
        }

        grossRecoveredLamports = grossRecovered;
        serviceFeeLamports = actualServiceFee;
        netRecoveredLamports = netRecovered;
        networkFeeLamports = actualNetworkFee;
      }

      if (publicKey.toBase58() === walletAddress) {
        setExecution({
          status: "confirmed",
          walletAddress,
          accountAddress,
          signature,
          grossRecoveredLamports,
          serviceFeeLamports,
          netRecoveredLamports,
          networkFeeLamports,
        });
      }
    } catch (executeError) {
      if (publicKey.toBase58() === walletAddress) {
        const errorMessage =
          executeError instanceof Error
            ? executeError.message
            : String(executeError);

        if (transactionConfirmed && signature) {
          // Подтверждение уже получено. Не разрешаем повторную отправку.
          setExecution({
            status: "confirmed",
            walletAddress,
            accountAddress,
            signature,
            grossRecoveredLamports: null,
            serviceFeeLamports: null,
            netRecoveredLamports: null,
            networkFeeLamports: null,
            verificationWarning:
              `Transaction is confirmed, but additional verification failed: ${errorMessage}`,
          });
        } else if (sendAttempted && signature) {
          // Проверяем результат только если RPC-отправка действительно началась.
          const outcome = await inspectTransactionOutcome(
            connection,
            signature,
          );

          if (outcome.status === "failed") {
            clearPendingRecord({
              network,
              walletAddress,
              accountAddress,
              signature,
            });

            setExecution({
              status: "error",
              walletAddress,
              accountAddress,
              signature,
              message:
                `The transaction was confirmed as failed: ${JSON.stringify(outcome.error)}`,
            });
          } else if (outcome.status === "confirmed") {
            let accountIsClosed = false;

            try {
              accountIsClosed =
                (await connection.getAccountInfo(
                  new PublicKey(accountAddress),
                  "confirmed",
                )) === null;
            } catch {
              accountIsClosed = false;
            }

            if (accountIsClosed) {
              clearPendingRecord({
                network,
                walletAddress,
                accountAddress,
                signature,
              });

              setExecution({
                status: "confirmed",
                walletAddress,
                accountAddress,
                signature,
                grossRecoveredLamports: null,
                serviceFeeLamports: null,
                netRecoveredLamports: null,
                networkFeeLamports: null,
                verificationWarning:
                  "Transaction is confirmed and the account is closed. The recovery breakdown could not be verified in this attempt.",
              });
            } else {
              setExecution({
                status: "unknown",
                walletAddress,
                accountAddress,
                signature,
                message:
                  "The transaction is confirmed, but account closure could not be verified. Do not submit it again.",
              });
            }
          } else {
            // Неизвестный результат: запись остаётся в localStorage.
            setExecution({
              status: "unknown",
              walletAddress,
              accountAddress,
              signature,
              message:
                `${errorMessage} Transaction status is not yet known. Do not submit it again until this signature is resolved.`,
            });
          }
        } else {
          // Подпись могла быть создана локально, но отправка ещё не начиналась.
          setExecution({
            status: "error",
            walletAddress,
            accountAddress,
            message: errorMessage,
          });
        }
      }
    } finally {
      executingAccountRef.current = null;
      setExecutingAccount(null);
    }
  }

  return (
    <div className="scanner-panel">
      <div className="scanner-heading">
        <div>
          <div className="section-label">WALLET SCAN & RECOVERY</div>
          <h3>Find empty token accounts</h3>
          <p>
            {readOnlyMode
              ? "Read-only mode: scans SPL Token and Token-2022 accounts owned by the connected wallet. Transaction preparation, signing and submission are disabled."
              : "Scans SPL Token and Token-2022 accounts owned by the connected wallet. You can prepare a CloseAccount transaction for eligible accounts. After preparation, Phantom can sign and submit the selected CloseAccount transaction."}
          </p>
        </div>

        <button
          className="wallet-button scanner-button"
          type="button"
          onClick={() => void handleScan()}
          disabled={
            !connected ||
            scanning ||
            preparingAccount !== null ||
            executingAccount !== null
          }
        >
          {scanning
            ? "Scanning…"
            : result
              ? "Scan again"
              : "Scan wallet"}
        </button>
      </div>

      {readOnlyMode && (
        <div className="scanner-preparation scanner-preparation-error" role="status">
          <strong>Mainnet read-only staging</strong>
          <p>Wallet scanning is enabled. Transaction preparation, wallet signing and transaction submission are disabled in this environment.</p>
        </div>
      )}

      {pendingStorageError && (
        <div className="scanner-preparation scanner-preparation-error" role="alert">
          <strong>Pending transaction safety storage unavailable</strong>
          <p>{pendingStorageError}</p>
          <p>
            Preparing and executing transactions are blocked until this
            storage problem is resolved. Do not clear the browser data.
          </p>
        </div>
      )}

      {walletPendingTransactions.length > 0 && (
        <div className="scanner-preparation scanner-preparation-error" role="alert">
          <strong>
            {walletPendingTransactions.length} unresolved transaction(s) — do not retry
          </strong>
          <p>
            These accounts remain locked until their transaction status and
            account state can be verified.
          </p>
          {walletPendingTransactions.map((item) => (
            <p key={`${item.network}:${item.accountAddress}`}>
              Account: {shortAddress(item.accountAddress)} · Signature:{" "}
              <a
                href={`https://explorer.solana.com/tx/${item.signature}?cluster=${network === "mainnet-beta" ? "mainnet-beta" : "devnet"}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction
              </a>
            </p>
          ))}
          <button
            className="wallet-button scanner-button"
            type="button"
            onClick={() => void handleRecheckPending()}
            disabled={recheckingPending || !pendingLoaded || Boolean(pendingStorageError)}
          >
            {recheckingPending ? "Checking transaction status…" : "Recheck pending transactions"}
          </button>
        </div>
      )}

      {!connected && (
        <p className="scanner-message">
          Connect your Solana wallet above to start a read-only scan.
        </p>
      )}

      {error && (
        <p className="scanner-error" role="alert">
          {error}
        </p>
      )}

      {scanning && (
        <p className="scanner-message" aria-live="polite">
          Reading token accounts from Solana {network === "mainnet-beta" ? "Mainnet" : "Devnet"}…
        </p>
      )}

      {summary && result && scannedWallet === walletAddress && (
        <>
          <div className="scanner-stats">
            <article className="scanner-stat scanner-stat-highlight">
              <span>Lamports in eligible accounts</span>
              <strong>{formatLamports(summary.grossLamports)} SOL</strong>
              <small>Current account balances, not guaranteed recovery</small>
            </article>

            <article className="scanner-stat">
              <span>Eligible accounts</span>
              <strong>{summary.eligibleCount}</strong>
              <small>Zero balance and supported state</small>
            </article>

            <article className="scanner-stat">
              <span>Needs review</span>
              <strong>{summary.reviewCount}</strong>
              <small>Unsupported, frozen or undecodable</small>
            </article>

            <article className="scanner-stat">
              <span>Contains tokens</span>
              <strong>{summary.hasTokensCount}</strong>
              <small>Excluded from empty-account recovery</small>
            </article>
          </div>

          <div className="scanner-result-meta">
            <span>
              Wallet balance: {formatLamports(result.walletLamports)} SOL
            </span>
            <span>Accounts scanned: {result.rows.length}</span>

            {result.warnings > 0 && (
              <span className="scanner-warning">
                {result.warnings} account(s) could not be decoded
              </span>
            )}
          </div>

          {result.rows.length === 0 ? (
            <div className="scanner-empty">
              No SPL Token or Token-2022 accounts were found.
            </div>
          ) : (
            <div className="scanner-list">
              {result.rows.map((row) => {
                const isPreparing =
                  visiblePreparation?.status === "preparing" &&
                  visiblePreparation.accountAddress === row.address;

                const canPrepare =
                  !readOnlyMode && row.status === "reclaimable";

                const rowPreparation =
                  visiblePreparation?.accountAddress === row.address
                    ? visiblePreparation
                    : null;

                return (
                  <div className="scanner-row-wrapper" key={row.address}>
                    <article className="scanner-row">
                      <div className="scanner-row-main">
                        <div
                          className="scanner-account-address"
                          title={row.address}
                        >
                          {shortAddress(row.address)}
                        </div>

                        <div className="scanner-account-meta">
                          {row.program} · Mint {shortAddress(row.mint)}
                        </div>

                        <div className="scanner-reason">{row.reason}</div>
                      </div>

                      <div className="scanner-row-side">
                        <span
                          className={`scanner-status scanner-status-${row.status}`}
                        >
                          {statusLabel(row)}
                        </span>

                        <strong>{formatLamports(row.lamports)} SOL</strong>
                        <small>Account lamports</small>

                        {canPrepare && (
                          <button
                            className="wallet-button scanner-prepare-button"
                            type="button"
                            onClick={() => void handlePrepare(row)}
                            disabled={
                              scanning ||
                              preparingAccount !== null ||
                              executingAccount !== null
                            }
                          >
                            {isPreparing
                              ? "Preparing…"
                              : "Prepare transaction"}
                          </button>
                        )}
                      </div>
                    </article>

                    {rowPreparation?.status === "success" && (
                      <div className="scanner-preparation scanner-preparation-success">
                        <div className="scanner-preparation-heading">
                          <span className="scanner-preparation-indicator" />
                          <strong>Transaction prepared</strong>
                        </div>

                        <div className="scanner-preparation-grid">
                          <div>
                            <small>Account balance</small>
                            <strong>
                              {formatLamports(
                                rowPreparation.prepared.rentLamports,
                              )}{" "}
                              SOL
                            </strong>
                          </div>

                          <div>
                            <small>
                              Estimated service fee (
                              {(rowPreparation.prepared.serviceFeeBps / 100).toFixed(2)}%)
                            </small>
                            <strong>
                              {formatLamports(
                                rowPreparation.prepared.serviceFeeLamports,
                              )}{" "}
                              SOL
                            </strong>
                          </div>

                          <div>
                            <small>Estimated net recovery</small>
                            <strong>
                              {formatLamports(
                                rowPreparation.prepared.estimatedNetRecoveredLamports,
                              )}{" "}
                              SOL
                            </strong>
                          </div>

                          <div>
                            <small>Estimated network fee</small>
                            <strong>
                              {formatLamports(
                                rowPreparation.prepared
                                  .estimatedNetworkFeeLamports,
                              )}{" "}
                              SOL
                            </strong>
                          </div>
                        </div>

                        <p>
                          Program: {rowPreparation.prepared.tokenProgram}.
                          Rent destination: connected wallet.
                        </p>

                        <p className="scanner-preparation-notice">
                          The unsigned transaction closes the selected account
                          and transfers the service fee to the configured treasury
                          atomically. The fee is calculated from the account
                          balance during preparation and remains fixed in the
                          transaction. If the account balance changes before
                          execution, the actual percentage may differ. Network
                          fees are paid separately by the connected wallet.
                          Review both instructions in Phantom before approving.
                        </p>

                        <button
                          className="wallet-button scanner-prepare-button"
                          type="button"
                          onClick={() => void handleExecute(rowPreparation.prepared)}
                          disabled={
                            executingAccount !== null ||
                            preparingAccount !== null ||
                            !pendingLoaded ||
                            Boolean(pendingStorageError) ||
                            walletPendingTransactions.some(
                              (item) => item.accountAddress === row.address,
                            ) ||
                            ((execution?.status === "confirmed" ||
                              execution?.status === "unknown") &&
                              execution.accountAddress === row.address)
                          }
                        >
                          {execution?.status === "sending" &&
                          execution.accountAddress === row.address
                            ? "Waiting for confirmation…"
                            : execution?.status === "confirmed" &&
                              execution.accountAddress === row.address
                              ? "Account recovered"
                              : execution?.status === "unknown" &&
                                execution.accountAddress === row.address
                                ? "Transaction status unknown"
                                : "Close account & recover"}
                        </button>

                        {execution?.accountAddress === row.address &&
                          execution.walletAddress === walletAddress &&
                          execution.status === "confirmed" && (
                            <div className="scanner-preparation-notice" role="status">
                              <strong>Account closed and transaction confirmed.</strong>
                              {execution.verificationWarning && (
                                <p role="status">{execution.verificationWarning}</p>
                              )}
                              {execution.grossRecoveredLamports !== null &&
                              execution.serviceFeeLamports !== null &&
                              execution.netRecoveredLamports !== null ? (
                                <>
                                  <p>
                                    Gross recovered:{" "}
                                    {formatLamports(execution.grossRecoveredLamports)} SOL
                                  </p>
                                  <p>
                                    Service fee:{" "}
                                    {formatLamports(execution.serviceFeeLamports)} SOL
                                  </p>
                                  <p>
                                    Net recovered before network fee:{" "}
                                    {formatLamports(execution.netRecoveredLamports)} SOL
                                  </p>
                                </>
                              ) : (
                                <p>
                                  Transaction confirmed, but the actual recovery
                                  breakdown is not available because transaction
                                  balance metadata could not be retrieved.
                                </p>
                              )}
                              {execution.networkFeeLamports !== null && (
                                <p>
                                  Network fee:{" "}
                                  {formatLamports(execution.networkFeeLamports)} SOL
                                </p>
                              )}
                              <p>
                                Signature:{" "}
                                <a
                                  href={`https://explorer.solana.com/tx/${execution.signature}?cluster=devnet`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  View on Solana Explorer
                                </a>
                              </p>
                            </div>
                          )}

                        {execution?.accountAddress === row.address &&
                          execution.walletAddress === walletAddress &&
                          execution.status === "unknown" && (
                            <div
                              className="scanner-preparation scanner-preparation-error"
                              role="alert"
                            >
                              <strong>Transaction status unknown — do not retry</strong>
                              <p>{execution.message}</p>
                              <p>
                                Signature:{" "}
                                <a
                                  href={`https://explorer.solana.com/tx/${execution.signature}?cluster=devnet`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Check transaction on Solana Explorer
                                </a>
                              </p>
                            </div>
                          )}

                        {execution?.accountAddress === row.address &&
                          execution.walletAddress === walletAddress &&
                          execution.status === "error" && (
                            <div
                              className="scanner-preparation scanner-preparation-error"
                              role="alert"
                            >
                              <strong>Transaction not fully verified</strong>
                              <p>{execution.message}</p>
                              {execution.signature && (
                                <p>
                                  <a
                                    href={`https://explorer.solana.com/tx/${execution.signature}?cluster=devnet`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Check transaction on Solana Explorer
                                  </a>
                                </p>
                              )}
                            </div>
                          )}

                      </div>
                    )}

                    {rowPreparation?.status === "error" && (
                      <div
                        className="scanner-preparation scanner-preparation-error"
                        role="alert"
                      >
                        <strong>Preparation failed</strong>
                        <p>{rowPreparation.message}</p>

                        {rowPreparation.logs.length > 0 && (
                          <details className="scanner-logs">
                            <summary>Technical details</summary>
                            <pre>{rowPreparation.logs.join("\n")}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="scanner-disclaimer">
        Scanning is read-only. The selected CloseAccount transaction and its
        service-fee transfer are revalidated before Phantom requests
        approval. The service fee is fixed before signing; network
        fees are separate. Actual recovery amounts are shown only after
        confirmed execution and transaction balance verification.
      </div>
    </div>
  );
}