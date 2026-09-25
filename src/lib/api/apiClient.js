/**
 * Ensures only one refresh request is in flight at a time so concurrent
 * 401s don't each try to rotate the refresh token (the rotation is
 * single-use, so a second concurrent call would look like a replay).
 */
let refreshInFlight = null;

async function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * A lightweight fetch wrapper for public and authenticated API calls.
 */
export async function apiClient(endpoint, { body, ...customConfig } = {}) {
  const headers = { 'Content-Type': 'application/json' };

  const config = {
    method: body ? 'POST' : 'GET',
    ...customConfig,
    headers: {
      ...headers,
      ...customConfig.headers,
    },
  };

  // Remove Content-Type if explicitly set to undefined (e.g. for FormData)
  if (config.headers['Content-Type'] === undefined) {
    delete config.headers['Content-Type'];
  }

  if (body) {
    config.body = body instanceof FormData ? body : JSON.stringify(body);
  }

  const isAuthRoute = endpoint.startsWith('/api/auth/');

  const doFetch = () => fetch(endpoint, config);

  try {
    let response = await doFetch();

    // The access token cookie expires every 15 minutes; silently rotate it
    // using the 7-day refresh token instead of forcing a re-login.
    if (response.status === 401 && !isAuthRoute) {
      const refreshed = await refreshSession();
      if (refreshed) {
        response = await doFetch();
      }
    }

    // Handle successful responses
    if (response.ok) {
      // Check if response is empty
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      }
      return await response.text();
    }

    if (response.status === 401) {
      console.warn('API Unauthorized: Session expired or refresh failed');
    }

    let errorData;
    try {
      errorData = await response.json();
    } catch (e) {
      errorData = { error: 'Unknown server error' };
    }

    const error = new Error(errorData.error || `HTTP error! status: ${response.status}`);
    error.status = response.status;
    error.data = errorData;

    console.error(`API Error [${response.status}] at ${endpoint}:`, error.message);
    throw error;
  } catch (err) {
    // If it's already an error object with status, just rethrow it
    if (err.status) throw err;

    const wrappedError = new Error(err.message || 'Network request failed');
    console.error(`API Network Error at ${endpoint}:`, wrappedError.message);
    throw wrappedError;
  }
}

