import { ACCEPTED_ASSET, NATIVE_ASSET } from "./chain";
import { resolveAssetIssuer } from "@/lib/stellar/horizonClient";

/**
 * Stellar assets a buyer can pay with at checkout.
 *
 * Native XLM is always offered alongside the configured anchor asset
 * (`NEXT_PUBLIC_ACCEPTED_ASSET`, default USDC); the list is deduplicated when
 * a deployment accepts XLM directly.
 *
 * `issuer` is resolved via resolveAssetIssuer (env override, else the known
 * testnet/mainnet issuer for the asset) rather than hardcoded null — a null
 * issuer here previously meant callers had nothing to check a resolved
 * payment asset against before checkout (#674).
 */
export function getSupportedPaymentAssets() {
  const assets = [
    {
      code: ACCEPTED_ASSET,
      issuer: resolveAssetIssuer(ACCEPTED_ASSET),
      label: `Stellar ${ACCEPTED_ASSET}`,
    },
  ];

  if (ACCEPTED_ASSET !== NATIVE_ASSET) {
    assets.push({
      code: NATIVE_ASSET,
      issuer: resolveAssetIssuer(NATIVE_ASSET),
      label: `Stellar ${NATIVE_ASSET}`,
    });
  }

  return assets;
}
