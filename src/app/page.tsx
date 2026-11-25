import { WalletConnect } from "@/components/wallet-connect";
import { WalletBatchScanner } from "@/components/wallet-batch-scanner";
import { PublicStats } from "@/components/public-stats";
import { HeroVisual } from "@/components/hero-visual";
import { getSolanaNetworkConfig } from "@/lib/reclaim/network";

function Logo() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
          <path d="M18 3L31 10.5V25.5L18 33L5 25.5V10.5L18 3Z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 13H25L21.5 16.5H11V13Z" fill="currentColor" />
          <path d="M11 19.5H25L21.5 23H11V19.5Z" fill="currentColor" />
        </svg>
      </div>
      <span>Reclaim<span className="brand-accent">SOL</span></span>
    </div>
  );
}

export default function Home() {
  const { network } = getSolanaNetworkConfig();
  const networkLabel = network === "mainnet-beta" ? "Solana Mainnet" : "Solana Devnet";
  return (
    <main className="app-shell">
      <header className="topbar">
        <Logo />
        <div className="topbar-right">
          <div className="network-badge"><span className="network-dot" />{networkLabel}</div>
          <WalletConnect />
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-line" />SOLANA ACCOUNT RECLAMATION</div>
        <h1>Your SOL.<br /><span>Back where it belongs.</span></h1>
        <p className="hero-description">
          Recover SOL locked in supported Solana token accounts.
          Non-zero balances require explicit irreversible burn consent. You stay in control of every signature.
        </p>
        <HeroVisual />
        <section className="fee-disclosure" aria-label="ReclaimSOL fee summary">
          <div className="fee-disclosure-grid">
            <div className="fee-disclosure-item"><span>Service fee</span><strong>15% of gross rent recovered</strong></div>
            <div className="fee-disclosure-item"><span>Network fee</span><strong>Charged by Solana at actual cost</strong></div>
            <div className="fee-disclosure-item"><span>Priority fee</span><strong>Zero by default</strong></div>
          </div>
          <p>There is no minimum or maximum service fee. The official ReclaimSOL client includes the fee transfer in the wallet transaction; it is not enforced by an on-chain ReclaimSOL program. Network fees are separate from the service fee. Always review the recipient and amounts in your wallet before signing.</p>
        </section>
        <div className="hero-actions">
          <span className="security-note">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.5L13 3.5V7.5C13 10.5 11 12.5 8 14.5C5 12.5 3 10.5 3 7.5V3.5L8 1.5Z" stroke="currentColor" strokeWidth="1.2" />
              <path d="M5.5 8L7.2 9.7L10.5 6.3" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            Non-custodial. You stay in control.
          </span>
        </div>
      </section>

      <PublicStats />

      <section className="workspace">
        <div className="workspace-header">
          <div><div className="section-label">YOUR WORKSPACE</div><h2>Account overview</h2></div>
          <div className="devnet-label"><span className="network-dot" />{network.toUpperCase()}</div>
        </div>
        <WalletBatchScanner />
      </section>

      <footer className="footer">
        <div className="footer-brand"><Logo /><span>© 2026 ReclaimSOL</span></div>
        <div className="footer-security">Your keys never leave your wallet.</div>
        <div className="footer-network"><span className="network-dot" />Built on Solana</div>
      </footer>
    </main>
  );
}
