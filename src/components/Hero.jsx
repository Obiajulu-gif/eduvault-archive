"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";

export default function Hero() {
  const fadeUp = {
    hidden: { opacity: 0, y: 30 },
    show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: "easeOut" } },
  };

  const staggerContainer = {
    hidden: {},
    show: { transition: { staggerChildren: 0.15 } },
  };

  return (
    <section className="relative min-h-[90vh] flex flex-col items-center justify-center pt-32 pb-20 px-6 overflow-hidden bg-white">
      {/* 🔹 Background Elements */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-full max-w-7xl opacity-[0.03] pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,#3E7BFF,transparent_70%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#000_1px,transparent_1px),linear-gradient(to_bottom,#000_1px,transparent_1px)] bg-[size:60px_60px]" />
      </div>

      <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-stellar-blue/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-accent-purple/5 rounded-full blur-[120px] pointer-events-none" />

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="relative z-10 max-w-6xl w-full grid lg:grid-cols-2 gap-12 items-center"
      >
        <div className="flex flex-col items-start text-left">
          <motion.div
            variants={fadeUp}
            className="flex items-center gap-2 bg-stellar-blue/5 border border-stellar-blue/10 px-4 py-1.5 rounded-full text-xs font-bold text-stellar-blue mb-6"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-stellar-blue opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-stellar-blue"></span>
            </span>
            Powered by Stellar Soroban
          </motion.div>

          <motion.h1
            variants={fadeUp}
            className="text-5xl md:text-7xl font-bold text-stellar-dark leading-[1.1] mb-6"
          >
            The Global <br />
            <span className="text-stellar-blue">Knowledge</span> <br />
            Commons.
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="text-edu-muted max-w-lg text-lg md:text-xl mb-10 leading-relaxed"
          >
            Own your academic assets. Publish research, study guides, and notes on Stellar to earn instant rewards from a global community of learners.
          </motion.p>

          <motion.div variants={fadeUp} className="flex flex-wrap gap-4">
            <Link
              href="/marketplace"
              className="bg-stellar-blue hover:bg-stellar-blue/90 text-white font-bold px-8 py-4 rounded-2xl transition-all duration-300 shadow-xl shadow-stellar-blue/20 flex items-center gap-2"
            >
              Explore Marketplace
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-7-7 7 7-7 7"/></svg>
            </Link>
            <Link
              href="/dashboard"
              className="bg-white border-2 border-gray-100 hover:border-stellar-blue/30 text-stellar-dark font-bold px-8 py-4 rounded-2xl transition-all duration-300"
            >
              Start Publishing
            </Link>
          </motion.div>

          <motion.div 
            variants={fadeUp}
            className="mt-12 pt-8 border-t border-gray-100 w-full flex items-center gap-6"
          >
            <div className="flex -space-x-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="w-10 h-10 rounded-full border-2 border-white bg-gray-100 overflow-hidden">
                  <Image src={`/images/stellar.png`} alt="User" width={40} height={40} className="grayscale opacity-50" />
                </div>
              ))}
            </div>
            <div className="text-sm">
              <span className="block font-bold text-stellar-dark">2,500+ Students</span>
              <span className="text-edu-muted">already earning on Stellar</span>
            </div>
          </motion.div>
        </div>

        <motion.div
          variants={fadeUp}
          className="relative flex justify-center lg:justify-end"
        >
          <div className="relative w-full max-w-[500px] aspect-square">
            {/* Glass Card Decoration */}
            <div className="absolute -top-6 -left-6 w-32 h-32 bg-stellar-blue/10 rounded-3xl blur-2xl animate-pulse" />
            <div className="absolute -bottom-6 -right-6 w-32 h-32 bg-accent-purple/10 rounded-3xl blur-2xl animate-pulse" />
            
            <div className="relative z-10 w-full h-full rounded-[2.5rem] overflow-hidden shadow-2xl border border-white/20 backdrop-blur-sm">
              <Image
                src="/hero-stellar.png"
                alt="EduVault Education Platform"
                fill
                className="object-cover"
                priority
              />
            </div>

            {/* Floating Achievement Card */}
            <motion.div 
              animate={{ y: [0, -10, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: "easeInOut" }}
              className="absolute -right-8 top-1/4 z-20 bg-white/90 backdrop-blur-md p-4 rounded-2xl shadow-xl border border-white/50 hidden md:block"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center text-green-600">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                </div>
                <div>
                  <span className="block text-[10px] uppercase tracking-wider text-edu-muted font-bold">Earnings</span>
                  <span className="block text-sm font-bold text-stellar-dark">+12.50 XLM</span>
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}

