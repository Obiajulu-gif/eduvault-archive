import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  clearRecentlyViewed,
  removeRecentlyViewed,
  setRecentlyViewedPaused,
  trackRecentlyViewed,
  useRecentlyViewed,
} from "@/hooks/useRecentlyViewed";

vi.mock("@/services/materialService", () => ({
  materialService: {
    getMaterialDetail: vi.fn(async (id) => ({ id, title: `Material ${id}`, price: 10 })),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = "QueryClientWrapper";
  return Wrapper;
}

describe("useRecentlyViewed", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearRecentlyViewed();
    setRecentlyViewedPaused(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a deduplicated, newest-first history in localStorage", () => {
    act(() => {
      trackRecentlyViewed({ id: "one" });
      trackRecentlyViewed({ id: "two" });
      trackRecentlyViewed({ id: "one" });
    });

    expect(JSON.parse(window.localStorage.getItem("eduvault.recentlyViewed"))).toEqual([
      "one",
      "two",
    ]);
  });

  it("clears history immediately and after remount", async () => {
    act(() => {
      trackRecentlyViewed({ id: "one" });
    });

    const { result, unmount } = renderHook(() => useRecentlyViewed(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      result.current.clearRecentlyViewed();
    });

    expect(result.current.ids).toEqual([]);
    expect(result.current.items).toEqual([]);
    expect(window.localStorage.getItem("eduvault.recentlyViewed")).toBe("[]");
    unmount();

    const remounted = renderHook(() => useRecentlyViewed(), {
      wrapper: createWrapper(),
    });
    expect(remounted.result.current.ids).toEqual([]);
    await waitFor(() => expect(remounted.result.current.items).toEqual([]));
  });

  it("removes only the requested item", async () => {
    act(() => {
      trackRecentlyViewed({ id: "one" });
      trackRecentlyViewed({ id: "two" });
    });

    const { result } = renderHook(() => useRecentlyViewed(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    act(() => {
      result.current.removeRecentlyViewed("one");
    });

    expect(result.current.ids).toEqual(["two"]);
    expect(window.localStorage.getItem("eduvault.recentlyViewed")).toBe('["two"]');
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(["two"]));
  });

  it("stops recording new entries while paused and persists the preference", async () => {
    act(() => {
      trackRecentlyViewed({ id: "one" });
    });

    const { result, unmount } = renderHook(() => useRecentlyViewed(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      result.current.setRecentlyViewedPaused(true);
    });

    expect(result.current.isTrackingPaused).toBe(true);
    expect(result.current.ids).toEqual([]);
    expect(result.current.items).toEqual([]);
    expect(window.localStorage.getItem("eduvault.recentlyViewed.pauseTracking")).toBe("true");

    act(() => {
      trackRecentlyViewed({ id: "two" });
    });
    expect(JSON.parse(window.localStorage.getItem("eduvault.recentlyViewed"))).toEqual(["one"]);
    unmount();

    const remounted = renderHook(() => useRecentlyViewed(), {
      wrapper: createWrapper(),
    });
    expect(remounted.result.current.isTrackingPaused).toBe(true);
    expect(remounted.result.current.items).toEqual([]);

    act(() => {
      setRecentlyViewedPaused(false);
    });
    trackRecentlyViewed({ id: "three" });
    expect(JSON.parse(window.localStorage.getItem("eduvault.recentlyViewed"))).toEqual([
      "three",
      "one",
    ]);
  });

  it("does not mutate storage when cancelling is handled by the caller", () => {
    act(() => {
      trackRecentlyViewed({ id: "one" });
    });
    const before = window.localStorage.getItem("eduvault.recentlyViewed");

    expect(removeRecentlyViewed("missing")).toBeUndefined();
    expect(window.localStorage.getItem("eduvault.recentlyViewed")).toBe(before);
  });
});
