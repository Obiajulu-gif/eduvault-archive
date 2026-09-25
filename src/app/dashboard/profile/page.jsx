"use client";

import Link from "next/link";
import { FaArrowLeft, FaUser } from "react-icons/fa";
import CreatorProfileSettings from "../components/CreatorProfileSettings";
import { useWallet } from "@/hooks/useWallet";
import { useUserProfile } from "@/hooks/api/useProfile";

export default function CreatorProfilePage() {
  const { address } = useWallet();
  const { data: profileData, isLoading } = useUserProfile(address);

  if (!address) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-950">Create your creator profile</h1>
        <p className="text-sm text-slate-600">
          Connect your wallet to start building the public profile that will appear beside every material you publish.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="rounded-3xl border border-slate-200 bg-linear-to-br from-slate-950 via-slate-900 to-slate-800 p-8 text-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-slate-200">
              <FaUser /> Creator profile
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">Shape your educator identity</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
              Add your name, institution, bio, and social links so learners can discover your work and trust your materials.
            </p>
          </div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
          >
            <FaArrowLeft /> Back to dashboard
          </Link>
        </div>
      </div>

      <div className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:grid-cols-3">
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-500">Public profile</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">Visible to learners</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-500">Profile completeness</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">{isLoading ? "Checking…" : profileData?.user ? "Ready to publish" : "Just getting started"}</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-500">Creator tools</p>
          <p className="mt-2 text-xl font-semibold text-slate-950">Upload, manage, and share</p>
        </div>
      </div>

      <CreatorProfileSettings initialUser={profileData?.user || {}} />
    </div>
  );
}
