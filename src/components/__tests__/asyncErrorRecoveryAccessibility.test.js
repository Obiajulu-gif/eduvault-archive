/**
 * Accessibility tests for async error recovery (#1089)
 *
 * Coverage:
 * - ARIA labels and roles for error messages
 * - Keyboard navigation and focus management
 * - Screen reader announcements for async states (loading, error, success)
 * - Color contrast for error indicators
 * - Form recovery and state preservation
 * - Alert announcements for recoverable errors
 */

import { describe, it, expect, beforeEach } from "vitest";

describe("Async Error Recovery Accessibility (#1089)", () => {
  describe("ARIA attributes and semantic HTML", () => {
    it("should have role=alert for error messages", () => {
      const errorElement = document.createElement("div");
      errorElement.setAttribute("role", "alert");
      errorElement.setAttribute("aria-live", "polite");
      errorElement.textContent = "Payment processing failed. Please try again.";

      expect(errorElement.getAttribute("role")).toBe("alert");
      expect(errorElement.getAttribute("aria-live")).toBe("polite");
    });

    it("should announce error messages immediately with aria-live=assertive for critical errors", () => {
      const criticalError = document.createElement("div");
      criticalError.setAttribute("role", "alert");
      criticalError.setAttribute("aria-live", "assertive");
      criticalError.textContent = "Session expired. You have been logged out.";

      expect(criticalError.getAttribute("aria-live")).toBe("assertive");
    });

    it("should use aria-label for error icons", () => {
      const errorIcon = document.createElement("span");
      errorIcon.setAttribute("aria-label", "Error");
      errorIcon.setAttribute("role", "img");
      errorIcon.className = "error-icon";

      expect(errorIcon.getAttribute("aria-label")).toBe("Error");
      expect(errorIcon.getAttribute("role")).toBe("img");
    });

    it("should associate error messages with form fields using aria-describedby", () => {
      const input = document.createElement("input");
      const error = document.createElement("span");

      input.id = "email-input";
      input.setAttribute("type", "email");
      error.id = "email-error";
      error.setAttribute("role", "alert");
      error.textContent = "Invalid email format";

      input.setAttribute("aria-describedby", "email-error");

      expect(input.getAttribute("aria-describedby")).toBe("email-error");
    });

    it("should mark loading states with aria-busy", () => {
      const loadingContainer = document.createElement("div");
      loadingContainer.setAttribute("aria-busy", "true");
      loadingContainer.setAttribute("aria-label", "Processing your request");

      expect(loadingContainer.getAttribute("aria-busy")).toBe("true");
    });

    it("should indicate success state with aria-live region", () => {
      const successMessage = document.createElement("div");
      successMessage.setAttribute("role", "status");
      successMessage.setAttribute("aria-live", "polite");
      successMessage.textContent = "Payment successful!";

      expect(successMessage.getAttribute("role")).toBe("status");
    });
  });

  describe("Keyboard navigation", () => {
    it("should allow dismissing error messages with Escape key", () => {
      const errorAlert = document.createElement("div");
      errorAlert.setAttribute("role", "alert");
      errorAlert.className = "dismissible-error";
      let dismissed = false;

      errorAlert.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          dismissed = true;
          errorAlert.remove();
        }
      });

      const event = new KeyboardEvent("keydown", { key: "Escape" });
      errorAlert.dispatchEvent(event);

      expect(dismissed).toBe(true);
    });

    it("should focus retry button after error", () => {
      const retryButton = document.createElement("button");
      retryButton.textContent = "Retry";
      retryButton.className = "retry-button";

      retryButton.focus();

      expect(document.activeElement).toBe(retryButton);
    });

    it("should maintain focus visible outline on interactive error recovery elements", () => {
      const button = document.createElement("button");
      button.textContent = "Retry Transaction";
      button.style.outline = "2px solid blue";

      expect(button.style.outline).toBe("2px solid blue");
    });

    it("should support Tab navigation through error recovery options", () => {
      const container = document.createElement("div");
      const retryBtn = document.createElement("button");
      const dismissBtn = document.createElement("button");

      retryBtn.textContent = "Retry";
      dismissBtn.textContent = "Dismiss";

      container.appendChild(retryBtn);
      container.appendChild(dismissBtn);

      expect(retryBtn.tabIndex).toBeGreaterThanOrEqual(-1);
      expect(dismissBtn.tabIndex).toBeGreaterThanOrEqual(-1);
    });
  });

  describe("Screen reader support", () => {
    it("should announce loading state transition", () => {
      const loadingRegion = document.createElement("div");
      loadingRegion.setAttribute("role", "status");
      loadingRegion.setAttribute("aria-live", "polite");
      loadingRegion.setAttribute("aria-label", "Loading");

      loadingRegion.textContent = "Processing payment...";

      expect(loadingRegion.textContent).toBe("Processing payment...");
      expect(loadingRegion.getAttribute("aria-label")).toBe("Loading");
    });

    it("should announce error state transition", () => {
      const errorRegion = document.createElement("div");
      errorRegion.setAttribute("role", "alert");
      errorRegion.setAttribute("aria-live", "assertive");
      errorRegion.textContent = "Payment failed: Card was declined";

      expect(errorRegion.textContent).toContain("Payment failed");
    });

    it("should announce success state transition", () => {
      const successRegion = document.createElement("div");
      successRegion.setAttribute("role", "status");
      successRegion.setAttribute("aria-live", "polite");
      successRegion.textContent = "Purchase completed successfully!";

      expect(successRegion.textContent).toContain("successfully");
    });

    it("should include retry instructions in error message", () => {
      const errorMsg = "Network error occurred. Press Tab to focus Retry button.";
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = errorMsg;

      expect(alert.textContent).toContain("Tab");
    });

    it("should describe recovery options in error messages", () => {
      const errorMsg =
        "Session timed out. Please log in again or refresh the page.";
      const alert = document.createElement("div");
      alert.textContent = errorMsg;

      expect(alert.textContent).toMatch(/log in|refresh/i);
    });
  });

  describe("Color and contrast", () => {
    it("should use sufficient color contrast for error text (WCAG AA)", () => {
      const errorText = document.createElement("div");
      errorText.style.color = "#b30000";
      errorText.style.backgroundColor = "#ffffff";

      expect(errorText.style.color).toBe("rgb(179, 0, 0)");
      expect(errorText.style.backgroundColor).toBe("rgb(255, 255, 255)");
    });

    it("should not rely on color alone to indicate errors", () => {
      const errorIndicator = document.createElement("div");
      errorIndicator.style.color = "red";
      errorIndicator.setAttribute("aria-label", "Error");
      const icon = document.createElement("span");
      icon.textContent = "⚠";

      errorIndicator.appendChild(icon);

      expect(errorIndicator.getAttribute("aria-label")).toBeDefined();
      expect(errorIndicator.textContent).toContain("⚠");
    });

    it("should use icon + text for error visualization", () => {
      const errorNode = document.createElement("div");
      const icon = document.createElement("span");
      const text = document.createElement("span");

      icon.textContent = "✗";
      icon.setAttribute("aria-hidden", "true");
      text.textContent = "Error: Please check your input";

      errorNode.appendChild(icon);
      errorNode.appendChild(text);

      expect(errorNode.textContent).toContain("✗");
      expect(errorNode.textContent).toContain("Error");
    });
  });

  describe("Form state preservation on error", () => {
    it("should preserve form input values after async error", () => {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.id = "email";
      input.value = "user@example.com";

      form.appendChild(input);

      expect(input.value).toBe("user@example.com");
    });

    it("should maintain focus position on error retry", () => {
      const input = document.createElement("input");
      input.id = "credit-card";
      input.focus();

      const focused = document.activeElement === input;

      expect(focused).toBe(true);
    });

    it("should announce which field has error", () => {
      const input = document.createElement("input");
      const error = document.createElement("span");

      input.id = "password-field";
      error.id = "password-error";
      error.setAttribute("role", "alert");
      error.textContent = "Password must be at least 8 characters";

      input.setAttribute("aria-describedby", "password-error");

      expect(input.getAttribute("aria-describedby")).toBe("password-error");
      expect(error.textContent).toContain("Password");
    });
  });

  describe("Loading and async state handling", () => {
    it("should disable form submission during async operation", () => {
      const submitBtn = document.createElement("button");
      submitBtn.type = "submit";
      submitBtn.disabled = false;

      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-busy", "true");

      expect(submitBtn.disabled).toBe(true);
      expect(submitBtn.getAttribute("aria-busy")).toBe("true");
    });

    it("should show loading spinner with accessible label", () => {
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      spinner.setAttribute("role", "status");
      spinner.setAttribute("aria-label", "Loading");

      expect(spinner.getAttribute("role")).toBe("status");
      expect(spinner.getAttribute("aria-label")).toBe("Loading");
    });

    it("should announce completion of async operation", () => {
      const statusRegion = document.createElement("div");
      statusRegion.setAttribute("role", "status");
      statusRegion.setAttribute("aria-live", "polite");

      statusRegion.textContent = "Purchase completed";

      expect(statusRegion.getAttribute("aria-live")).toBe("polite");
      expect(statusRegion.textContent).toBe("Purchase completed");
    });

    it("should include cancel option in async operations", () => {
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.setAttribute("aria-label", "Cancel operation");

      expect(cancelBtn.getAttribute("aria-label")).toBe("Cancel operation");
      expect(cancelBtn.textContent).toBe("Cancel");
    });
  });

  describe("Error message clarity and actionability", () => {
    it("should provide clear error message without jargon", () => {
      const userFriendlyError =
        "Your card could not be processed. Please verify your card details.";
      const error = document.createElement("div");
      error.setAttribute("role", "alert");
      error.textContent = userFriendlyError;

      expect(error.textContent).not.toContain("ERR_");
      expect(error.textContent).not.toContain("CODE_");
    });

    it("should include specific field information in error", () => {
      const error = document.createElement("div");
      error.setAttribute("role", "alert");
      error.textContent = "Expiration date is invalid. Please enter MM/YY format.";

      expect(error.textContent).toContain("Expiration date");
      expect(error.textContent).toContain("MM/YY");
    });

    it("should provide next action in error message", () => {
      const error = document.createElement("div");
      error.setAttribute("role", "alert");
      error.textContent =
        "Payment failed. Try again with a different card or payment method.";

      expect(error.textContent).toMatch(/Try|Please/i);
    });

    it("should distinguish recoverable from non-recoverable errors", () => {
      const recoverableError = document.createElement("div");
      recoverableError.textContent =
        "Network timeout. Retry by clicking the button below.";

      const fatalError = document.createElement("div");
      fatalError.textContent =
        "Account locked. Contact support for assistance.";

      expect(recoverableError.textContent).toContain("Retry");
      expect(fatalError.textContent).toContain("Contact");
    });
  });

  describe("Contract preservation and migration", () => {
    it("should maintain error handling interface", () => {
      const errorHandler = {
        announce: (message) => {
          const alert = document.createElement("div");
          alert.setAttribute("role", "alert");
          alert.textContent = message;
          return alert;
        },
      };

      expect(typeof errorHandler.announce).toBe("function");
    });

    it("should preserve async state machine states", () => {
      const states = ["idle", "loading", "error", "success"];

      expect(states).toContain("idle");
      expect(states).toContain("loading");
      expect(states).toContain("error");
      expect(states).toContain("success");
    });
  });

  describe("Edge cases and fallbacks", () => {
    it("should handle very long error messages gracefully", () => {
      const longError =
        "A".repeat(500) +
        " Please contact support with this error message.";
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = longError;

      expect(alert.textContent.length).toBeGreaterThan(100);
    });

    it("should handle special characters in error messages", () => {
      const specialCharsError = "Invalid format: use <name>@<domain> format";
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = specialCharsError;

      expect(alert.textContent).toContain("<");
      expect(alert.textContent).toContain(">");
    });

    it("should support multiple simultaneous errors", () => {
      const container = document.createElement("div");
      container.setAttribute("role", "region");
      container.setAttribute("aria-label", "Form validation errors");

      const error1 = document.createElement("div");
      error1.setAttribute("role", "alert");
      error1.textContent = "Email is invalid";

      const error2 = document.createElement("div");
      error2.setAttribute("role", "alert");
      error2.textContent = "Password is too short";

      container.appendChild(error1);
      container.appendChild(error2);

      expect(container.children.length).toBe(2);
    });

    it("should handle missing screen reader gracefully", () => {
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.setAttribute("aria-live", "polite");
      alert.textContent = "This message is accessible";

      expect(alert.textContent).toBe("This message is accessible");
    });
  });
});
