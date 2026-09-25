/**
 * Performance measurement utilities for ISR optimization
 */

export function measureTTFB(label = "TTFB") {
  if (typeof window !== "undefined" && window.performance) {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (navigation) {
      const ttfb = navigation.responseStart - navigation.fetchStart;
      console.log(`[${label}] Time to First Byte: ${ttfb.toFixed(2)}ms`);
      return ttfb;
    }
  }
  return null;
}

export function measurePageLoad(label = "Page Load") {
  if (typeof window !== "undefined" && window.performance) {
    const start = performance.now();
    
    return {
      end: () => {
        const duration = performance.now() - start;
        console.log(`[${label}] Load duration: ${duration.toFixed(2)}ms`);
        return duration;
      }
    };
  }
  return { end: () => null };
}

export function logPerformanceMetrics() {
  if (typeof window !== "undefined" && window.performance) {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (navigation) {
      console.log("Performance Metrics:", {
        ttfb: `${(navigation.responseStart - navigation.fetchStart).toFixed(2)}ms`,
        fcp: navigation.firstContentfulPaint ? `${navigation.firstContentfulPaint.toFixed(2)}ms` : "N/A",
        lcp: navigation.largestContentfulPaint ? `${navigation.largestContentfulPaint.toFixed(2)}ms` : "N/A",
        domContentLoaded: `${(navigation.domContentLoadedEventEnd - navigation.fetchStart).toFixed(2)}ms`,
        loadComplete: `${(navigation.loadEventEnd - navigation.fetchStart).toFixed(2)}ms`,
      });
    }
  }
}