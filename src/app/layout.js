import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import Web3Provider from "@/providers/Web3Provider";
import { ToastProvider } from "@/providers/ToastProvider";
import { CartProvider } from "@/providers/CartProvider";
import { ComparisonProvider } from "@/providers/ComparisonProvider";
import CartDrawer from "@/components/CartDrawer";
import ComparisonMatrix from "@/components/ComparisonMatrix";
import SupportWidget from "@/components/SupportWidget";
import SessionWarning from "@/components/SessionWarning";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "EduVault - Decentralized Educational Materials Sharing",
  description: "Share and monetize your educational materials on the blockchain with EduVault",
  icons: {
    icon: "/logo.png",              // general favicon
    shortcut: "/logo.png",          // legacy shortcut icon
    apple: "/logo.png"     // optional iOS icon (place in public/ if used)
  },
};

const themeInitScript = `
(() => {
  try {
    const storageKey = "eduvault-theme";
    const storedTheme = window.localStorage.getItem(storageKey);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : (prefersDark ? "dark" : "light");

    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (error) {}
})();
`;

export default async function RootLayout({ children }) {
  // The nonce is set by middleware.js per request (issue #649) and threaded
  // through via the x-nonce request header — applying it here is what lets
  // this one inline script satisfy the nonce-based script-src CSP without
  // needing 'unsafe-inline'.
  const headerList = await headers();
  const nonce = headerList.get("x-nonce");

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <Web3Provider>
          <ToastProvider>
            <CartProvider>
              <ComparisonProvider>
                {children}
                <CartDrawer />
                <ComparisonMatrix />
                <SupportWidget />
                <SessionWarning />
              </ComparisonProvider>
            </CartProvider>
          </ToastProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
