import { normalizeExternalUrl, REMOTE_IMAGE_HOSTS } from "../security/input.js";

export class StorageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StorageError";
    this.details = details;
  }
}

/**
 * Validates Pinata response format.
 * @param {any} response The raw response from Pinata API/SDK
 * @param {string} type Description of file being uploaded
 * @returns {any} The verified response
 */
export function validatePinataResponse(response, type = "file") {
  if (!response || typeof response !== "object") {
    throw new StorageError(`Invalid storage response from Pinata for ${type}.`, {
      type,
      response,
    });
  }
  if (!response.cid || typeof response.cid !== "string" || response.cid.trim() === "") {
    throw new StorageError(`Storage response for ${type} is missing a valid CID.`, {
      type,
      response,
    });
  }
  return response;
}

/**
 * Validates converted gateway URL.
 * @param {string} url The gateway URL
 * @param {string} type Description of file being resolved
 * @returns {string} The verified URL
 */
export function validateGatewayUrl(url, type = "file") {
  try {
    const gatewayHost = process.env.NEXT_PUBLIC_GATEWAY_URL
      ? new URL(process.env.NEXT_PUBLIC_GATEWAY_URL).hostname
      : null;
    return normalizeExternalUrl(url, {
      allowedHosts: [...REMOTE_IMAGE_HOSTS, gatewayHost].filter(Boolean),
    });
  } catch {
    throw new StorageError(`Invalid gateway URL returned for ${type}: "${url || ""}"`, {
      type,
      url,
    });
  }
}

/**
 * Retries a promise-returning function with exponential backoff.
 * @param {Function} fn The function to execute
 * @param {number} retries Maximum number of attempts
 * @param {number} delay Initial delay in milliseconds
 * @param {Function} onRetry Optional callback for when an attempt fails
 * @returns {Promise<any>}
 */
export async function retryWithBackoff(fn, retries = 3, delay = 1000, onRetry = null) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= retries) {
        throw error;
      }
      if (onRetry) {
        onRetry(error, attempt);
      } else {
        console.warn(
          `[Storage Retry] Attempt ${attempt} failed: ${error.message}. Retrying in ${
            delay * Math.pow(2, attempt - 1)
          }ms...`
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, delay * Math.pow(2, attempt - 1))
      );
    }
  }
}
