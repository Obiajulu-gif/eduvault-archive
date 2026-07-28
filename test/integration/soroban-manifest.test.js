import { describe, it, expect } from "vitest";
import {
  buildManifest,
  serializeManifest,
  parseManifest,
  manifestToEnvVars,
  manifestPathFor,
} from "../../scripts/lib/soroban-manifest.mjs";

const REGISTRY_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5C";
const MANAGER_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB5C";

describe("soroban-manifest helpers", () => {
  it("builds a manifest with the required contract IDs", () => {
    const m = buildManifest({
      network: "testnet",
      materialRegistryId: REGISTRY_ID,
      purchaseManagerId: MANAGER_ID,
      admin: "GADMIN",
      treasury: "GTREASURY",
      platformFeeBps: 250,
      deployer: "deployer",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(m.network).toBe("testnet");
    expect(m.deployedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(m.contracts.materialRegistry).toBe(REGISTRY_ID);
    expect(m.contracts.purchaseManager).toBe(MANAGER_ID);
    expect(m.config).toEqual({
      admin: "GADMIN",
      treasury: "GTREASURY",
      platformFeeBps: 250,
    });
  });

  it("omits the config block when no config fields are provided", () => {
    const m = buildManifest({
      network: "testnet",
      materialRegistryId: REGISTRY_ID,
      purchaseManagerId: MANAGER_ID,
    });
    expect(m.config).toBeUndefined();
  });

  it("throws when a required field is missing", () => {
    expect(() =>
      buildManifest({ network: "testnet", purchaseManagerId: MANAGER_ID }),
    ).toThrow(/materialRegistryId is required/);
    expect(() =>
      buildManifest({ materialRegistryId: REGISTRY_ID, purchaseManagerId: MANAGER_ID }),
    ).toThrow(/network is required/);
  });

  it("round-trips through serialize/parse", () => {
    const m = buildManifest({
      network: "futurenet",
      materialRegistryId: REGISTRY_ID,
      purchaseManagerId: MANAGER_ID,
    });
    const text = serializeManifest(m);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = parseManifest(text);
    expect(parsed.contracts.materialRegistry).toBe(REGISTRY_ID);
    expect(parsed.contracts.purchaseManager).toBe(MANAGER_ID);
  });

  it("rejects malformed manifests on parse", () => {
    expect(() => parseManifest("not json")).toThrow(/invalid JSON/);
    expect(() => parseManifest("{}")).toThrow(/missing a contracts section/);
    expect(() =>
      parseManifest(JSON.stringify({ contracts: { materialRegistry: REGISTRY_ID } })),
    ).toThrow(/purchaseManager are required/);
  });

  it("maps a manifest to the NEXT_PUBLIC contract env vars", () => {
    const m = buildManifest({
      network: "testnet",
      materialRegistryId: REGISTRY_ID,
      purchaseManagerId: MANAGER_ID,
    });
    expect(manifestToEnvVars(m)).toEqual({
      NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID: REGISTRY_ID,
      NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID: MANAGER_ID,
    });
  });

  it("derives a per-network manifest path", () => {
    expect(manifestPathFor("testnet")).toBe("soroban/deployments/testnet.json");
    expect(manifestPathFor("mainnet")).toBe("soroban/deployments/mainnet.json");
  });
});
