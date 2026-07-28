import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Web3Provider from "@/providers/Web3Provider";
import { ToastProvider } from "@/providers/ToastProvider";
import { CartProvider } from "@/providers/CartProvider";
import { ComparisonProvider } from "@/providers/ComparisonProvider";
import CartDrawer from "@/components/CartDrawer";
import ComparisonMatrix from "@/components/ComparisonMatrix";
import SupportWidget from "@/components/SupportWidget";

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

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <Web3Provider>
          <ToastProvider>
            <CartProvider>
              <ComparisonProvider>
                {children}
                <CartDrawer />
                <ComparisonMatrix />
                <SupportWidget />
              </ComparisonProvider>
            </CartProvider>
          </ToastProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
