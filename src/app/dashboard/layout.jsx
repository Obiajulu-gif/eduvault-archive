"use client";

import Sidebar from "./components/Sidebar";
import DashboardHeader from "./components/DashboardHeader";
import ErrorBoundary from "@/components/ErrorBoundary";

export default function DashboardLayout({ children }) {
	return (
		<div className="flex min-h-screen bg-background text-foreground overflow-hidden">
			{/* Sidebar */}
			<Sidebar />

			{/* Main Content Area */}
			<div className="flex-1 flex flex-col ml-64 min-h-screen">
				{/* Sticky Navbar/Header */}
				<DashboardHeader />

				{/* Scrollable main content */}
				<main className="flex-1 overflow-y-auto p-8 bg-background">
					<div className="max-w-7xl mx-auto">
						<ErrorBoundary
							fallbackTitle="Dashboard error"
							fallbackDescription="Something went wrong while loading your dashboard. Try again or report the issue."
						>
							{children}
						</ErrorBoundary>
					</div>
				</main>
			</div>
		</div>
	);
}
