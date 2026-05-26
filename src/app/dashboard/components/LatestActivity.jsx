"use client";
import Link from "next/link";
import { FaBook, FaDownload, FaStar } from "react-icons/fa";
import { usePurchaseHistory } from "@/hooks/api/usePurchases";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import { ActivityItemSkeleton } from "@/components/common/DataSkeleton";

export default function LatestActivity() {
  const purchaseQuery = usePurchaseHistory();

  return (
    <div className="p-6 bg-white border border-gray-100 rounded-xl shadow-sm">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-bold text-gray-900">Your Latest Activity</h3>
        <button className="text-indigo-600 hover:text-indigo-700 font-medium text-sm">See All</button>
      </div>
      
      <QueryStateProvider 
        query={purchaseQuery}
        loadingComponent={
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map(i => <ActivityItemSkeleton key={i} />)}
          </div>
        }
        emptyComponent={

          <div className="text-center py-8">
            <p className="text-sm text-gray-500">No activity yet. Start exploring the marketplace!</p>
            <Link href="/marketplace" className="text-indigo-600 text-xs font-medium mt-2 inline-block">Go to Marketplace</Link>
          </div>
        }
        renderData={(purchases) => (
          <div className="space-y-5">
            {purchases.slice(0, 5).map((a) => (
              <div key={a._id} className="flex gap-4 items-start group">
                <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-50 transition-colors">
                  <FaBook className="text-blue-500" />
                </div>
                <div className="flex-1 pb-4 border-b border-gray-50 group-last:border-0 group-last:pb-0">
                  <p className="text-sm text-gray-800 leading-snug mb-1">
                    Purchased material: <span className="font-medium text-indigo-900">{a.materialId}</span>
                  </p>
                  <span className="text-xs text-gray-500 font-medium">
                    {new Date(a.purchasedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      />
    </div>
  );
}

