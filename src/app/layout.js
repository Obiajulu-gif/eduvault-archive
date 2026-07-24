import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import Web3Provider from "@/providers/Web3Provider";
import { ToastProvider } from "@/providers/ToastProvider";
import { CartProvider } from "@/providers/CartProvider";
import { ComparisonProvider } from "@/providers/ComparisonProvider";
import CartDrawer from "@/components/CartDrawer";
import ComparisonMatrix from "@/components/ComparisonMatrix";

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
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png"
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
  const nonce = (await headers()).get("x-nonce") || undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded-lg focus:shadow-lg focus:text-sm focus:font-bold"
        >
          Skip to main content
        </a>
        <Web3Provider>
          <ToastProvider>
            <CartProvider>
              <ComparisonProvider>
                <div id="main-content" role="main" tabIndex={-1}>
                  {children}
                </div>
                <CartDrawer />
                <ComparisonMatrix />
              </ComparisonProvider>
            </CartProvider>
          </ToastProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
