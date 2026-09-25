# Stellar Wallet Setup Guide

This guide walks users through installing and connecting a Stellar-compatible wallet to EduVault for purchasing and managing educational materials.

## Supported Wallets

EduVault uses the [Stellar Wallets Kit](https://github.com/creit-tech/stellar-wallets-kit) to support multiple Stellar wallets through a unified connection flow. Compatible wallets include:

| Wallet | Type | Platform | Link |
| --- | --- | --- | --- |
| **Freighter** | Browser extension | Chrome, Firefox, Brave | [freighter.app](https://freighter.app) |
| **LOBSTR** | Mobile wallet | iOS, Android | [lobstr.co](https://lobstr.co) |
| **Albedo** | Web-based | Browser | [albedo.link](https://albedo.link) |
| **Rabet** | Browser extension | Chrome, Firefox | [rabet.app](https://rabet.app) |
| **Stellar Bifrost** | Web-based | Browser | [bifrost.stellar.org](https://bifrost.stellar.org) |

**Recommended for desktop users:** Freighter — a lightweight browser extension that stores keys locally and integrates directly with web applications.

## Installing Freighter (Recommended)

### Step 1: Install the Extension

1. Open your browser (Chrome, Firefox, or Brave).
2. Navigate to the [Freighter Chrome Web Store](https://chrome.google.com/webstore/detail/freighter/bcacfklncafkhfbchdheinjiomhagkei) or the [Freighter Firefox Add-ons page](https://addons.mozilla.org/en-US/firefox/addon/freighter/).
3. Click **Add to Browser**.
4. Confirm the installation when prompted.

### Step 2: Create or Import a Wallet

1. Click the Freighter icon in your browser toolbar.
2. If this is your first time, select **Create a new wallet**.
3. Write down the 12-word recovery phrase and store it securely offline.
4. Set a strong password to protect local access.
5. If you already have a Stellar wallet, select **Import wallet** and enter your secret key or recovery phrase.

### Step 3: Fund Your Wallet

Stellar accounts require a minimum balance of 1 XLM. To fund a new account on the testnet:

1. Open Freighter and copy your public key (starts with `G...`).
2. Visit the [Stellar Friendbot](https://friendbot.stellar.org/) page.
3. Paste your public key and click **Get test network lumens**.

Your account will be credited with testnet XLM within a few seconds.

### Step 4: Connect to EduVault

1. Open EduVault and navigate to the **Dashboard** or any page requiring wallet access.
2. Click **Connect Wallet**.
3. Select your wallet (e.g., Freighter) from the connection modal.
4. Approve the connection request in the wallet popup.
5. Your public address will appear in the top navigation once connected.

## Connecting on Mobile

Mobile users can connect through LOBSTR or any wallet that supports the Stellar Wallet Connect protocol:

1. Install LOBSTR from the App Store or Google Play.
2. Create or import a Stellar account.
3. Open EduVault in your mobile browser.
4. Tap **Connect Wallet** and select the mobile-compatible option.
5. Approve the connection in the LOBSTR app.

## Network Configuration

EduVault targets the Stellar testnet during development and staging. Ensure your wallet is set to the correct network:

- **Testnet passphrase:** `Test SDF Network ; September 2015`
- **Mainnet passphrase:** `Public Global Stellar Network ; September 2015`

The app will alert you if your wallet is connected to the wrong network. Switch networks in your wallet settings before proceeding.

## Reconnecting After Session Expiry

EduVault wallet sessions expire after 24 hours for security. To reconnect:

1. Return to EduVault.
2. Click **Connect Wallet** again.
3. Approve the connection in the wallet popup.

Your previous session data (materials, purchase history, and entitlements) remains intact on-chain and in the marketplace.

## Troubleshooting

| Issue | Solution |
| --- | --- |
| Wallet not detected | Ensure the extension is installed and enabled. Refresh the page. |
| Wrong network error | Switch your wallet to the correct Stellar network in wallet settings. |
| Connection rejected | Click **Connect Wallet** again and approve the popup promptly. |
| Account not funded | Use the [Friendbot](https://friendbot.stellar.org/) to fund testnet accounts. |
| Transaction fails | Verify sufficient XLM balance for the purchase and gas fees. |

## Security Notes

- EduVault never has access to your secret key. All signing happens locally in your wallet extension or app.
- Do not share your recovery phrase with anyone, including EduVault support.
- Session data is stored in `localStorage` and expires automatically after 24 hours.
- For production use, ensure your wallet is configured to the Stellar mainnet.

## Related Documentation

- [Stellar Integration Guide](stellar-integration.md)
- [Stellar Purchase Flow](stellar-purchase-flow.md)
- [Environment Setup](environment-setup.md)
