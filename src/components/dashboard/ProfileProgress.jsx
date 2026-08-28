import { useState, useEffect } from "react";
import Link from "next/link";
import { profileService } from "@/services/profileService";
import { useWallet } from "@/hooks/useWallet";

export default function ProfileProgress() {
  const { address } = useWallet();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }
    const fetchProfile = async () => {
      try {
        const res = await profileService.getProfile(address);
        if (res.user) {
          setUser(res.user);
        }
      } catch (err) {
        console.error("Failed to fetch profile:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, [address]);

  if (loading || !address) return null;

  const tasks = [
    { key: "bio", label: "Add a Bio", isComplete: !!user?.bio, link: "/dashboard/settings" },
    { key: "avatar", label: "Upload a Profile Photo", isComplete: !!user?.avatarUrl, link: "/dashboard/settings" },
    { key: "website", label: "Add a Website URL", isComplete: !!user?.websiteUrl, link: "/dashboard/settings" },
    { key: "payoutWallet", label: "Set Target Pricing Wallet", isComplete: !!user?.payoutWalletAddress, link: "/dashboard/settings" },
  ];

  const completedCount = tasks.filter((t) => t.isComplete).length;
  const totalCount = tasks.length;
  const progressPercentage = Math.round((completedCount / totalCount) * 100);

  if (progressPercentage === 100) {
    return null; // hide when fully complete
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm mb-6">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-lg font-bold text-gray-900">Profile Completion</h3>
        <span className="text-sm font-semibold text-blue-600">{progressPercentage}% Complete</span>
      </div>
      
      <div className="w-full bg-gray-200 rounded-full h-2.5 mb-6">
        <div 
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" 
          style={{ width: `${progressPercentage}%` }}
        ></div>
      </div>

      <div className="space-y-3">
        <p className="text-sm text-gray-600 mb-3">Complete these tasks to build buyer trust:</p>
        <ul className="space-y-2">
          {tasks.filter(t => !t.isComplete).map((task) => (
            <li key={task.key} className="flex justify-between items-center text-sm border border-gray-100 bg-gray-50 p-3 rounded-lg">
              <span className="text-gray-700">{task.label}</span>
              <Link href={task.link} className="text-blue-600 font-medium hover:underline text-xs bg-blue-50 px-3 py-1.5 rounded-md">
                Add Now
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
