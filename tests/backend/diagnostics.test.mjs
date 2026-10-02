import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runDiagnostics } from '../../scripts/diagnostics.mjs';
import { MongoClient } from 'mongodb';

vi.mock('fs');
vi.mock('mongodb');

describe('diagnostics script', () => {
  let logMock;
  let errorMock;

  beforeEach(() => {
    logMock = vi.fn();
    errorMock = vi.fn();
    vi.resetAllMocks();
    process.env = {}; // Clear env for test
  });

  it('passes when all environment requirements are met', async () => {
    // 1. Mock Node version - handled implicitly because vitest runs in >= 18 usually, but we can't mock process.version easily.
    // Assuming process.version is >= 18 for this test.
    
    // 2. Mock fs.existsSync to return true for both node_modules and .env.local
    fs.existsSync.mockReturnValue(true);
    
    // 3. Set required env vars
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.MONGODB_URI = 'mongodb://localhost:27017';
    
    // 4. Mock MongoClient
    const mockDb = {
      collection: vi.fn().mockReturnValue({
        countDocuments: vi.fn().mockResolvedValue(5) // > 0 to simulate fixtures present
      })
    };
    const mockClient = {
      connect: vi.fn().mockResolvedValue(),
      db: vi.fn().mockReturnValue(mockDb),
      close: vi.fn().mockResolvedValue()
    };
    MongoClient.mockReturnValue(mockClient);

    const result = await runDiagnostics({ log: logMock, error: errorMock });
    
    expect(result).toBe(true);
    expect(errorMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('All diagnostics passed!'));
  });

  it('fails when environment variables and fixtures are missing', async () => {
    // 2. Mock fs to return false for .env.local and node_modules
    fs.existsSync.mockReturnValue(false);
    
    // 3. Clear required env vars
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.MONGODB_URI;
    
    // 4. Mock MongoClient connection failure
    const mockClient = {
      connect: vi.fn().mockRejectedValue(new Error('Connection failed'))
    };
    MongoClient.mockReturnValue(mockClient);

    const result = await runDiagnostics({ log: logMock, error: errorMock });
    
    expect(result).toBe(false);
    
    // Check remediation messages
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('node_modules directory is missing'));
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('.env.local file is missing'));
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('Environment variable NEXT_PUBLIC_APP_URL is missing'));
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('Failed to connect to MongoDB'));
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('diagnostic check(s) failed'));
  });
});