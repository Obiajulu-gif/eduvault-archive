"use client";

import Link from "next/link";
import { motion } from "framer-motion";

export default function HowItWorks() {
	const steps = [
		{
			color: "from-stellar-blue to-accent-purple",
			title: "Connect Stellar Wallet",
			description:
				"Link your favorite Stellar wallet (like Freighter or Albedo) to establish your secure academic identity.",
			delay: 0.1,
		},
		{
			color: "from-accent-teal to-stellar-blue",
			title: "Certify Your Work",
			description:
				"Upload your materials and certify them on the Soroban network to ensure ownership and traceability.",
			delay: 0.2,
		},
		{
			color: "from-yellow-400 to-orange-500",
			title: "Earn Global Rewards",
			description:
				"Receive instant XLM or USDC payments whenever students access your certified knowledge materials.",
			delay: 0.3,
		},
	];

	const fadeUp = {
		hidden: { opacity: 0, y: 30 },
		show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } },
	};

	return (
		<section className="relative bg-stellar-dark text-white py-24 px-6 md:px-16 rounded-[3rem] my-20 mx-4 md:mx-8 overflow-hidden shadow-2xl" id="howitworks">
			{/* 🔹 Background Glow */}
			<div className="absolute top-0 right-0 w-[600px] h-[600px] bg-stellar-blue/10 rounded-full blur-[150px] pointer-events-none" />
			<div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-accent-purple/10 rounded-full blur-[150px] pointer-events-none" />

			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative flex flex-col md:flex-row md:items-end justify-between mb-16 z-10"
			>
				<div className="max-w-2xl">
					<h2 className="text-4xl md:text-5xl font-bold mb-6 leading-tight">
						Knowledge Exchange <br />
						<span className="text-stellar-blue">Powered by Soroban</span>
					</h2>
					<p className="text-gray-400 text-lg">
						A seamless protocol for academic asset ownership and monetization.
					</p>
				</div>
				<Link
					href="/dashboard"
					className="mt-8 md:mt-0 inline-flex items-center gap-2 bg-white text-stellar-dark font-bold py-4 px-8 rounded-2xl hover:bg-gray-100 transition-all duration-300 shadow-xl shadow-white/5"
				>
					Get Started Now
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-7-7 7 7-7 7"/></svg>
				</Link>
			</motion.div>

			<div className="grid md:grid-cols-3 gap-8 relative z-10">
				{steps.map((step, i) => (
					<motion.div
						key={i}
						initial={{ opacity: 0, y: 30 }}
						whileInView={{
							opacity: 1,
							y: 0,
							transition: { delay: step.delay, duration: 0.5, ease: "easeOut" },
						}}
						whileHover={{
							y: -8,
							backgroundColor: "rgba(255, 255, 255, 0.05)",
						}}
						className="bg-white/5 border border-white/10 rounded-[2.5rem] p-10 transition-all duration-300 backdrop-blur-md"
					>
						<div
							className={`w-14 h-14 mb-8 rounded-2xl bg-gradient-to-br ${step.color} flex items-center justify-center shadow-lg`}
						>
							<span className="text-2xl font-black text-white">{i + 1}</span>
						</div>

						<h3 className="text-xl font-bold mb-4 tracking-tight text-white">
							{step.title}
						</h3>
						<p className="text-gray-400 leading-relaxed">
							{step.description}
						</p>
					</motion.div>
				))}
			</div>

			<motion.div
				initial={{ opacity: 0, scaleX: 0 }}
				whileInView={{ opacity: 1, scaleX: 1 }}
				transition={{ duration: 1, delay: 0.5 }}
				className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-stellar-blue to-transparent opacity-20"
			/>
		</section>
	);
}

