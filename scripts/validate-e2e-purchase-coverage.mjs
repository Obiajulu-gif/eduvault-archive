#!/usr/bin/env node

/**
 * Validation script for E2E Purchase Flow Test Coverage (Issue #787)
 *
 * This script validates that:
 * 1. The E2E test file exists
 * 2. Test fixtures are properly defined
 * 3. Mock configuration is correct
 * 4. The test suite can run successfully
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const TEST_FILE = resolve(PROJECT_ROOT, 'test/integration/purchase-flow-e2e.test.js');
const FIXTURES_FILE = resolve(PROJECT_ROOT, 'test/fixtures/index.js');
const SETUP_FILE = resolve(PROJECT_ROOT, 'test/setup.js');
const SETUP_VITEST_FILE = resolve(PROJECT_ROOT, 'test/setup-vitest.js');
const DOCUMENTATION_FILE = resolve(PROJECT_ROOT, 'docs/e2e-purchase-flow-coverage.md');

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'blue');
  console.log('='.repeat(60));
}

function checkFileExists(filePath, description) {
  if (existsSync(filePath)) {
    log(`✓ ${description} exists`, 'green');
    return true;
  } else {
    log(`✗ ${description} NOT found at: ${filePath}`, 'red');
    return false;
  }
}

function checkFileContains(filePath, patterns, description) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const allFound = patterns.every(pattern => content.includes(pattern));

    if (allFound) {
      log(`✓ ${description} contains required patterns`, 'green');
      return true;
    } else {
      const missing = patterns.filter(p => !content.includes(p));
      log(`✗ ${description} missing patterns: ${missing.join(', ')}`, 'red');
      return false;
    }
  } catch (error) {
    log(`✗ Failed to read ${description}: ${error.message}`, 'red');
    return false;
  }
}

function runTestSuite() {
  logSection('Running E2E Test Suite');
  try {
    log('Running: npm test -- test/integration/purchase-flow-e2e.test.js', 'yellow');
    const output = execSync('npm test -- test/integration/purchase-flow-e2e.test.js --run', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120000,
    });
    log('✓ Test suite executed successfully', 'green');
    console.log(output);
    return true;
  } catch (error) {
    log('✗ Test suite execution failed', 'red');
    console.error(error.stdout || error.message);
    return false;
  }
}

function main() {
  logSection('E2E Purchase Flow Test Coverage Validation');
  log('Issue #787: Create end-to-end test coverage for the highest-risk user journey', 'yellow');

  let allChecksPassed = true;

  // Check file existence
  logSection('File Existence Checks');
  allChecksPassed &= checkFileExists(TEST_FILE, 'E2E test file');
  allChecksPassed &= checkFileExists(FIXTURES_FILE, 'Test fixtures file');
  allChecksPassed &= checkFileExists(SETUP_FILE, 'Test setup file');
  allChecksPassed &= checkFileExists(SETUP_VITEST_FILE, 'Vitest setup file');
  allChecksPassed &= checkFileExists(DOCUMENTATION_FILE, 'Documentation file');

  // Check test file content
  logSection('Test File Content Checks');
  allChecksPassed &= checkFileContains(TEST_FILE, [
    'describe(\'Purchase Flow E2E',
    'Happy Path - Successful Purchase',
    'Validation Failures',
    'Payment Failures',
    'Duplicate Purchase Prevention',
    'Retry and Recovery',
    'Access Control After Purchase',
  ], 'Test file with required test categories');

  // Check fixtures
  logSection('Test Fixtures Checks');
  allChecksPassed &= checkFileContains(FIXTURES_FILE, [
    'purchaseFixtures',
    'material',
    'checkoutQuote',
    'purchase',
    'entitlement',
  ], 'Fixtures file with purchase flow fixtures');

  // Check setup files
  logSection('Setup Files Checks');
  allChecksPassed &= checkFileContains(SETUP_FILE, [
    'mockCollections',
    'materials',
    'purchases',
    'entitlement_cache',
    'checkout_quotes',
    'checkout_intents',
  ], 'Setup file with required collection mocks');

  allChecksPassed &= checkFileContains(SETUP_VITEST_FILE, [
    'vi.mock',
    'checkBuyerTrustline',
    'applyTaxToCheckout',
    'verifyDiscount',
    'createEntitlement',
  ], 'Vitest setup file with service mocks');

  // Check documentation
  logSection('Documentation Checks');
  allChecksPassed &= checkFileContains(DOCUMENTATION_FILE, [
    'Purchase Flow Test Coverage',
    'Happy Path',
    'Validation Failures',
    'Payment Failures',
    'Duplicate Purchase Prevention',
    'Retry and Recovery',
    'Access Control',
  ], 'Documentation with required sections');

  // Run tests (optional - can be skipped with --skip-tests flag)
  const skipTests = process.argv.includes('--skip-tests');
  if (!skipTests) {
    allChecksPassed &= runTestSuite();
  } else {
    log('\nSkipping test execution (--skip-tests flag provided)', 'yellow');
  }

  // Final summary
  logSection('Validation Summary');
  if (allChecksPassed) {
    log('✓ All validation checks passed!', 'green');
    log('\nThe E2E purchase flow test coverage is properly implemented.', 'green');
    log('\nTo run the tests manually:', 'yellow');
    log('  npm test -- test/integration/purchase-flow-e2e.test.js', 'yellow');
    process.exit(0);
  } else {
    log('✗ Some validation checks failed.', 'red');
    log('\nPlease review the errors above and fix the issues.', 'red');
    process.exit(1);
  }
}

main();
