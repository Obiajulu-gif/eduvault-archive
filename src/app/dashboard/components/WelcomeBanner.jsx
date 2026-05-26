"use client";
import { FaUpload } from "react-icons/fa";

export default function WelcomeBanner({ user }) {
    const firstName = (user?.fullName || "Student").split(" ")[0];
    return (
        <div>
            <h1 className="text-3xl font-bold mb-4">Welcome back, {firstName}!</h1>
            <div className="relative bg-gradient-to-r from-blue-600 to-indigo-700 rounded-xl p-6 md:p-8 overflow-hidden min-h-[140px] shadow-sm">
                <div className="relative z-10 max-w-[70%]">
                    <p className="text-white mb-5 text-lg md:text-xl font-semibold leading-snug">
                        <span className="block">Upload and monetize</span>
                        <span className="block">your study materials today</span>
                    </p>
                    <button className="bg-white text-indigo-700 px-5 py-2.5 rounded-full hover:bg-gray-50 shadow-sm font-medium flex items-center gap-2 transition">
                        <FaUpload className="w-4 h-4" />
                        <span>Upload Material</span>
                    </button>
                </div>
                {/* Decorative circles */}
                <div className="absolute top-0 right-0 -mr-8 -mt-8 w-48 h-48 rounded-full bg-white opacity-10 blur-2xl"></div>
                <div className="absolute bottom-0 right-16 -mb-8 w-32 h-32 rounded-full bg-white opacity-10 blur-xl"></div>
            </div>
        </div>
    );
}
