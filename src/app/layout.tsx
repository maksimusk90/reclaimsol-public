import type { Metadata, Viewport } from "next";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "ReclaimSOL — Recover Your Solana Rent",
  description:
    "Reclaim SOL locked in empty Solana token accounts. Non-custodial wallet connection.",
  applicationName: "ReclaimSOL",
};

export const viewport: Viewport = {
  themeColor: "#090b12",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
