import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const { NEXT_PUBLIC_STELLAR_RPC_URL, NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID, NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID } = process.env;

if (!NEXT_PUBLIC_STELLAR_RPC_URL) {
  throw new Error('NEXT_PUBLIC_STELLAR_RPC_URL is required to deploy Soroban contracts');
}

console.log('Deploying Soroban contracts to Stellar testnet...');

try {
  console.log('Building MaterialRegistry contract...');
  execSync('cargo build --target wasm32-unknown-unknown --release', {
    cwd: './soroban/contracts/material-registry',
    stdio: 'inherit',
  });

  console.log('Deploying MaterialRegistry contract...');
  const materialRegistryId = execSync(
    `soroban deploy --wasm ./soroban/contracts/material-registry/target/wasm32-unknown-unknown/release/material_registry.wasm --rpc ${NEXT_PUBLIC_STELLAR_RPC_URL}`,
    { stdio: 'pipe' }
  ).toString().trim();

  console.log(`MaterialRegistry deployed with ID: ${materialRegistryId}`);

  console.log('Building PurchaseManager contract...');
  execSync('cargo build --target wasm32-unknown-unknown --release', {
    cwd: './soroban/contracts/purchase-manager',
    stdio: 'inherit',
  });

  console.log('Deploying PurchaseManager contract...');
  const purchaseManagerId = execSync(
    `soroban deploy --wasm ./soroban/contracts/purchase-manager/target/wasm32-unknown-unknown/release/purchase_manager.wasm --rpc ${NEXT_PUBLIC_STELLAR_RPC_URL}`,
    { stdio: 'pipe' }
  ).toString().trim();

  console.log(`PurchaseManager deployed with ID: ${purchaseManagerId}`);

  console.log('Deployment complete. Update your environment variables with the following IDs:');
  console.log(`NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID=${materialRegistryId}`);
  console.log(`NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID=${purchaseManagerId}`);
} catch (error) {
  console.error('Deployment failed:', error.message);
  process.exit(1);
}