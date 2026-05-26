import React from 'react';

export function SkeletonBase({ className = '' }) {
  return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}

export function MaterialCardSkeleton() {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm p-4">
      <SkeletonBase className="w-full h-44 mb-4" />
      <SkeletonBase className="w-3/4 h-4 mb-2" />
      <SkeletonBase className="w-1/2 h-3 mb-4" />
      <div className="flex justify-between items-center">
        <SkeletonBase className="w-1/4 h-4" />
        <SkeletonBase className="w-1/4 h-4" />
      </div>
    </div>
  );
}

export function ActivityItemSkeleton() {
  return (
    <div className="flex gap-4 items-start py-2">
      <SkeletonBase className="w-10 h-10 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <SkeletonBase className="w-full h-3" />
        <SkeletonBase className="w-1/4 h-2" />
      </div>
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
      <div className="flex justify-between items-center mb-3">
        <SkeletonBase className="w-20 h-3" />
        <SkeletonBase className="w-6 h-6 rounded-full" />
      </div>
      <SkeletonBase className="w-24 h-8 mb-2" />
      <SkeletonBase className="w-16 h-3" />
    </div>
  );
}

export function CreatorItemSkeleton() {
  return (
    <div className="flex justify-between items-center py-2">
      <div className="flex items-center gap-3">
        <SkeletonBase className="w-10 h-10 rounded-full" />
        <div className="space-y-1">
          <SkeletonBase className="w-24 h-3" />
          <SkeletonBase className="w-16 h-2" />
        </div>
      </div>
      <SkeletonBase className="w-8 h-4 rounded-full" />
    </div>
  );
}
