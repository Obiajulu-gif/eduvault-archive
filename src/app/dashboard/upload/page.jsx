"use client";

import UploadWizard from "./components/UploadWizard";

export default function UploadPage() {
	return (
		<div className="min-h-screen bg-gray-50 text-gray-900">
			<div className="max-w-7xl mx-auto py-10 px-6 grid md:grid-cols-3 gap-8">
				{/* Left side: Upload form */}
				<div className="md:col-span-2">
					<UploadWizard />
				</div>

				{/* Right side: Steps */}
				<aside className="bg-white border border-gray-200 rounded-xl p-6 h-fit">
					<h3 className="text-lg font-semibold mb-6">Upload Material Page</h3>
					<ol className="space-y-4">
						<li className="flex items-start gap-3">
							<span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-semibold">
								1
							</span>
							<p className="text-sm text-gray-700">
							Connect your wallet and prepare your educational material.
						</p>
						</li>
						<li className="flex items-start gap-3 opacity-50">
							<span className="flex-shrink-0 w-6 h-6 border border-gray-300 rounded-full flex items-center justify-center text-sm font-semibold">
								2
							</span>
						<p className="text-sm text-gray-700">
							Add title, description, price, and the right category for discovery.
						</p>
						</li>
						<li className="flex items-start gap-3 opacity-50">
							<span className="flex-shrink-0 w-6 h-6 border border-gray-300 rounded-full flex items-center justify-center text-sm font-semibold">
								3
							</span>
						<p className="text-sm text-gray-700">Publish to the EduVault marketplace and share your work.</p>
						</li>
						<li className="flex items-start gap-3 opacity-50">
							<span className="flex-shrink-0 w-6 h-6 border border-gray-300 rounded-full flex items-center justify-center text-sm font-semibold">
								4
							</span>
						<p className="text-sm text-gray-700">Track your listing and update details from your dashboard.</p>
						<p className="text-sm text-gray-600 mb-4">
							Get to know how your campaign can reach a wider audience.
						</p>
						<button className="border border-gray-300 px-4 py-2 rounded-md text-sm hover:bg-gray-100 transition">
							Contact Us
						</button>
					</div>
				</aside>
			</div>
		</div>
	);
}
