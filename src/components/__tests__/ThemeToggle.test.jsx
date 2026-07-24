import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import ThemeToggle from "../ThemeToggle";

describe("ThemeToggle", () => {
	beforeEach(() => {
		// Mock localStorage for jsdom
		let mockStorage = {};
		window.localStorage = {
			getItem: (key) => mockStorage[key] || null,
			setItem: (key, val) => { mockStorage[key] = String(val); },
			clear: () => { mockStorage = {}; },
		};

		window.localStorage.clear();
		document.documentElement.dataset.theme = "light";
		document.documentElement.style.colorScheme = "light";
		window.localStorage.setItem("eduvault-theme", "light");
	});

	it("switches the app theme and persists the choice", async () => {
		render(<ThemeToggle />);

		const button = await screen.findByRole("button", { name: /switch to dark theme/i });
		fireEvent.click(button);

		await waitFor(() => {
			expect(document.documentElement.dataset.theme).toBe("dark");
			expect(window.localStorage.getItem("eduvault-theme")).toBe("dark");
		});
	});
});
