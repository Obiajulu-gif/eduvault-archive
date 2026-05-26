"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { FaCrown, FaArrowRight } from "react-icons/fa";

export default function TopSharedMaterials() {
  const sharedMaterials = [
    { title: "CHM 112 - Lab Report (Year 1)", price: "0.25 XLM", author: "Dr. Smith" },
    { title: "GNS 201 - Use of English (Year 2)", price: "0.25 XLM", author: "Prof. Jane" },
    { title: "CSC 301 - Data Structures (Year 3)", price: "0.26 XLM", author: "Engr. Alex" },
  ];

  const topAuthors = [
    { rank: 1, name: "CryptoFunks", earnings: "0.25 XLM", change: "+26.52%", color: "text-green-500" },
    { rank: 2, name: "Cryptix", earnings: "0.25 XLM", change: "+10.52%", color: "text-red-500" },
    { rank: 3, name: "Frenesware", earnings: "0.25 XLM", change: "+5.52%", color: "text-green-500" },
    { rank: 4, name: "PunkArt", earnings: "50,008 XLM", change: "+1.52%", color: "text-green-500" },
    { rank: 5, name: "Art Crypto", earnings: "4,524 XLM", change: "+2.52%", color: "text-red-500" },
  ];

  const fadeUp = {
    hidden: { opacity: 0, y: 40 },
    show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } },
  };

  return (
    <section className="relative py-24 px-6 md:px-16 overflow-hidden bg-white">
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true }}
        variants={fadeUp}
        className="relative flex flex-col md:flex-row md:items-end justify-between mb-16 z-10"
      >
        <div className="max-w-2xl">
          <h2 className="text-4xl md:text-5xl font-bold text-stellar-dark mb-4">
            Top Shared Materials
          </h2>
          <p className="text-edu-muted text-lg">
            Discover what is trending in the EduVault community this week.
          </p>
        </div>
        <Link 
          href="/marketplace"
          className="mt-8 md:mt-0 flex items-center gap-2 text-sm font-bold text-stellar-blue hover:gap-3 transition-all"
        >
          Browse All Materials <FaArrowRight />
        </Link>
      </motion.div>

      <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-10 z-10 items-start">
        {/* Featured Material */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          variants={fadeUp}
          className="lg:col-span-5 relative group"
        >
          <div className="relative h-[450px] rounded-[2.5rem] overflow-hidden shadow-2xl border border-gray-100 transition-all duration-500 group-hover:shadow-stellar-blue/10">
            <Image
              src="/images/Generated Image November 07, 2025 - 7_02AM.png"
              alt="ECN 101 Preview"
              fill
              className="object-cover transition-transform duration-700 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-stellar-dark/90 via-stellar-dark/20 to-transparent" />
            
            <div className="absolute bottom-0 w-full p-8 text-white">
              <div className="flex items-center gap-2 mb-4">
                <span className="bg-stellar-blue text-[10px] uppercase tracking-widest font-bold px-3 py-1 rounded-full">Featured</span>
              </div>
              <h3 className="text-2xl font-bold mb-2">
                ECN 101 - Principles of Microeconomics
              </h3>
              <p className="text-gray-300 text-sm mb-6 flex items-center gap-2">
                By Chijioke M. <span className="w-1 h-1 bg-gray-500 rounded-full" /> Year 1
              </p>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center">
                    <Image src="/images/stellar.png" alt="Stellar" width={16} height={16} />
                  </div>
                  <span className="text-xl font-bold">0.25 XLM</span>
                </div>
                <button className="bg-white text-stellar-dark font-bold px-6 py-3 rounded-xl hover:bg-gray-100 transition-all shadow-lg">
                  Access Now
                </button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Small List */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          variants={fadeUp}
          className="lg:col-span-4 flex flex-col gap-4"
        >
          {sharedMaterials.map((material, i) => (
            <motion.div
              key={i}
              whileHover={{ x: 8 }}
              className="flex items-center justify-between bg-white border border-gray-100 rounded-[1.5rem] p-5 shadow-sm transition-all duration-300 hover:border-stellar-blue/20"
            >
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 bg-edu-light rounded-2xl flex items-center justify-center text-2xl shadow-inner">
                  📚
                </div>
                <div>
                  <h3 className="text-sm font-bold text-stellar-dark truncate max-w-[150px]">
                    {material.title}
                  </h3>
                  <p className="text-xs text-edu-muted mb-2">{material.author}</p>
                  <div className="flex items-center gap-1.5">
                    <Image src="/images/stellar.png" alt="Stellar" width={12} height={12} />
                    <span className="text-xs font-bold text-stellar-blue">{material.price}</span>
                  </div>
                </div>
              </div>
              <button className="w-10 h-10 rounded-full border border-gray-100 flex items-center justify-center text-stellar-blue hover:bg-stellar-blue hover:text-white transition-all">
                <FaArrowRight size={12} />
              </button>
            </motion.div>
          ))}
        </motion.div>

        {/* Top Authors */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          variants={fadeUp}
          className="lg:col-span-3 bg-edu-light rounded-[2.5rem] p-8 border border-gray-100 shadow-inner"
        >
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-yellow-100 rounded-xl flex items-center justify-center text-yellow-600">
              <FaCrown />
            </div>
            <div>
              <h3 className="font-bold text-stellar-dark">Top Earners</h3>
              <p className="text-[10px] uppercase tracking-widest text-edu-muted font-bold">This Week</p>
            </div>
          </div>
          
          <div className="space-y-4">
            {topAuthors.map((author) => (
              <div
                key={author.rank}
                className="flex justify-between items-center bg-white rounded-2xl p-4 shadow-sm border border-gray-50/50"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-edu-muted w-4">{author.rank}</span>
                  <div>
                    <h4 className="text-xs font-bold text-stellar-dark">{author.name}</h4>
                    <p className="text-[10px] text-stellar-blue font-bold">{author.earnings}</p>
                  </div>
                </div>
                <span className={`text-[10px] font-bold ${author.color}`}>{author.change}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
