"use client";

import { FaXTwitter, FaLinkedinIn, FaInstagram } from "react-icons/fa6";
import Link from "next/link";
import Image from "next/image";

export default function Footer() {
	return (
		<footer className="bg-stellar-dark text-gray-400 py-16 px-6 md:px-16 mt-20 border-t border-white/5" role="contentinfo">
			<div className="max-w-7xl mx-auto">
				<div className="flex flex-col lg:flex-row justify-between items-start gap-12 mb-16">
					<div className="max-w-sm">
						<Link href="/" className="flex items-center gap-3 mb-6 group" aria-label="EduVault Home">
							<div className="relative w-10 h-10 rounded-full overflow-hidden border border-white/10 group-hover:border-stellar-blue transition-colors">
								<Image
									src="/logo.png"
									alt="EduVault Logo"
									fill
									className="object-cover"
								/>
							</div>
							<div className="text-2xl font-bold tracking-tight text-white">
								EduVault<span className="text-stellar-blue">.</span>
							</div>
						</Link>
						<p className="text-sm leading-relaxed mb-8 text-gray-500">
							The global knowledge commons powered by Stellar. Empowering students and researchers to own and monetize their academic contributions securely.
						</p>
						<div className="flex items-center gap-4 text-gray-500">
							<a href="https://x.com/eduvault1" target="_blank" rel="noopener noreferrer" className="hover:text-stellar-blue transition-colors p-2 bg-white/5 rounded-lg focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none" aria-label="Follow EduVault on X (Twitter)">
								<FaXTwitter size={18} aria-hidden="true" />
							</a>
							<Link href="#" className="hover:text-stellar-blue transition-colors p-2 bg-white/5 rounded-lg focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none" aria-label="Follow EduVault on LinkedIn">
								<FaLinkedinIn size={18} aria-hidden="true" />
							</Link>
							<Link href="#" className="hover:text-stellar-blue transition-colors p-2 bg-white/5 rounded-lg focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none" aria-label="Follow EduVault on Instagram">
								<FaInstagram size={18} aria-hidden="true" />
							</Link>
						</div>
					</div>

					<div className="grid grid-cols-2 md:grid-cols-3 gap-12 lg:gap-24">
						<nav aria-label="Platform links">
							<h4 className="text-white font-bold mb-6 text-sm uppercase tracking-widest">Platform</h4>
							<ul className="space-y-4 text-sm">
								<li><Link href="/marketplace" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Marketplace</Link></li>
								<li><Link href="/#howitworks" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">How It Works</Link></li>
								<li><Link href="/dashboard" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Publisher Dashboard</Link></li>
							</ul>
						</nav>
						<nav aria-label="Resource links">
							<h4 className="text-white font-bold mb-6 text-sm uppercase tracking-widest">Resources</h4>
							<ul className="space-y-4 text-sm">
								<li><Link href="https://edu-vault.gitbook.io/edu-vault-docs/" target="_blank" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Documentation</Link></li>
								<li><Link href="#" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Support Center</Link></li>
								<li><Link href="#" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Terms of Service</Link></li>
							</ul>
						</nav>
						<div className="col-span-2 md:col-span-1">
							<h4 className="text-white font-bold mb-6 text-sm uppercase tracking-widest">Newsletter</h4>
							<p className="text-xs mb-4 text-gray-500">Get the latest updates on the Stellar education ecosystem.</p>
							<form className="flex bg-white/5 border border-white/10 rounded-xl overflow-hidden p-1 focus-within:border-stellar-blue/50 transition-all" onSubmit={(e) => e.preventDefault()} aria-label="Newsletter signup">
								<label htmlFor="newsletter-email" className="sr-only">Email address</label>
								<input
									id="newsletter-email"
									type="email"
									placeholder="Email address"
									className="bg-transparent px-4 py-2.5 text-xs text-white w-full focus:outline-none"
									aria-required="true"
								/>
								<button type="submit" className="bg-stellar-blue hover:bg-stellar-blue/90 text-white text-xs font-bold px-4 py-2.5 rounded-lg transition-all focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none">
									Join
								</button>
							</form>
						</div>
					</div>
				</div>

				<div className="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-6 text-[10px] font-bold uppercase tracking-widest text-gray-600">
					<p>© {new Date().getFullYear()} EDUVAULT. BUILT ON STELLAR.</p>
					<nav aria-label="Legal links">
						<div className="flex gap-8">
							<Link href="#" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Privacy Policy</Link>
							<Link href="#" className="hover:text-white transition focus-visible:ring-2 focus-visible:ring-stellar-blue focus-visible:outline-none rounded">Cookies</Link>
						</div>
					</nav>
				</div>
			</div>
		</footer>
	);
}
