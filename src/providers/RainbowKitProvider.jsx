"use client";

import { RainbowKitProvider as RKProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

const CUSTOM_THEME = {
  radii: {
    actionButton: "12px",
    connectButton: "12px",
    modal: "16px",
    modalMobile: "12px",
  },
};

export default function RainbowKitProvider({ children }) {
  return (
    <RKProvider
      theme={{
        lightMode: lightTheme({ ...CUSTOM_THEME, accentColor: "#2563eb" }),
        darkMode: darkTheme({ ...CUSTOM_THEME, accentColor: "#3b82f6" }),
      }}
      coolMode
    >
      {children}
    </RKProvider>
  );
}
