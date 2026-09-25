"use client";

import { useState, useRef, useEffect } from "react";
import { FaSearch, FaExchangeAlt, FaTimes, FaExpand, FaCompress } from "react-icons/fa";
import Image from "next/image";

export default function CatalogComparison({ materials = [] }) {
  const [selectedLeft, setSelectedLeft] = useState(null);
  const [selectedRight, setSelectedRight] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOffsetRef = useRef({ x: 0, y: 0 });

  const filteredMaterials = materials.filter(
    (m) =>
      m.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.subject?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const leftItem = materials.find(
    (m) => (m._id || m.id) === selectedLeft
  );
  const rightItem = materials.find(
    (m) => (m._id || m.id) === selectedRight
  );

  function handleZoomIn() {
    setZoomLevel((prev) => Math.min(prev + 0.25, 3));
  }

  function handleZoomOut() {
    setZoomLevel((prev) => Math.max(prev - 0.25, 0.5));
  }

  function handleResetZoom() {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  }

  function handleMouseDown(e) {
    if (zoomLevel <= 1) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX, y: e.clientY };
    panOffsetRef.current = { ...panOffset };
  }

  function handleMouseMove(e) {
    if (!isPanning) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setPanOffset({
      x: panOffsetRef.current.x + dx,
      y: panOffsetRef.current.y + dy,
    });
  }

  function handleMouseUp() {
    setIsPanning(false);
  }

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setSelectedLeft(null);
        setSelectedRight(null);
        setZoomLevel(1);
        setPanOffset({ x: 0, y: 0 });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-full">
      {/* Selection Panel */}
      <div className="w-full lg:w-72 bg-white border border-gray-200 rounded-xl p-4 flex flex-col">
        <div className="relative mb-4">
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search materials..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {filteredMaterials.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">
              No materials found
            </p>
          ) : (
            filteredMaterials.map((material) => {
              const id = material._id || material.id;
              const isSelectedLeft = selectedLeft === id;
              const isSelectedRight = selectedRight === id;

              return (
                <div
                  key={id}
                  className={`p-2 rounded-lg border cursor-pointer transition-all text-sm ${
                    isSelectedLeft
                      ? "border-blue-500 bg-blue-50"
                      : isSelectedRight
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  <p className="font-medium text-gray-900 truncate">
                    {material.title}
                  </p>
                  <div className="flex gap-2 mt-1">
                    <button
                      onClick={() =>
                        setSelectedLeft(isSelectedLeft ? null : id)
                      }
                      className={`text-[10px] px-2 py-0.5 rounded font-semibold transition ${
                        isSelectedLeft
                          ? "bg-blue-600 text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {isSelectedLeft ? "Left ✓" : "Left"}
                    </button>
                    <button
                      onClick={() =>
                        setSelectedRight(isSelectedRight ? null : id)
                      }
                      className={`text-[10px] px-2 py-0.5 rounded font-semibold transition ${
                        isSelectedRight
                          ? "bg-emerald-600 text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {isSelectedRight ? "Right ✓" : "Right"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Comparison View */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 bg-white border border-gray-200 rounded-xl px-4 py-2">
          <div className="flex items-center gap-2">
            <FaExchangeAlt className="text-blue-500" />
            <span className="text-sm font-semibold text-gray-700">
              Side-by-Side Comparison
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleZoomOut}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
              aria-label="Zoom out"
            >
              −
            </button>
            <span className="text-xs text-gray-500 min-w-[3rem] text-center">
              {Math.round(zoomLevel * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              onClick={handleResetZoom}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
              aria-label="Reset zoom"
            >
              {zoomLevel > 1 ? <FaCompress className="w-3 h-3" /> : <FaExpand className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* Side-by-Side Panels */}
        <div
          className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4"
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <ComparisonPanel
            item={leftItem}
            label="Left"
            zoomLevel={zoomLevel}
            panOffset={panOffset}
            isPanning={isPanning}
            onMouseDown={handleMouseDown}
          />
          <ComparisonPanel
            item={rightItem}
            label="Right"
            zoomLevel={zoomLevel}
            panOffset={panOffset}
            isPanning={isPanning}
            onMouseDown={handleMouseDown}
          />
        </div>
      </div>
    </div>
  );
}

function ComparisonPanel({
  item,
  label,
  zoomLevel,
  panOffset,
  isPanning,
  onMouseDown,
}) {
  const bgColor = label === "Left" ? "blue" : "emerald";

  if (!item) {
    return (
      <div className="bg-white border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center min-h-[400px]">
        <FaExchangeAlt className="w-12 h-12 text-gray-300 mb-3" />
        <p className="text-gray-400 text-sm font-medium">
          Select a material for the {label} panel
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col">
      <div className={`px-4 py-2 border-b border-gray-100 bg-${bgColor}-50`}>
        <h3 className="text-sm font-bold text-gray-900 truncate">
          {item.title}
        </h3>
        <p className="text-[11px] text-gray-500">
          {item.subject || "Academics"} · {item.fileType || "PDF"}
        </p>
      </div>

      <div
        className="flex-1 overflow-hidden relative bg-gray-50 min-h-[350px]"
        onMouseDown={onMouseDown}
        style={{ cursor: isPanning ? "grabbing" : zoomLevel > 1 ? "grab" : "default" }}
      >
        <div
          style={{
            transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
            transformOrigin: "center center",
            transition: isPanning ? "none" : "transform 0.2s ease",
          }}
          className="w-full h-full flex items-center justify-center p-4"
        >
          {item.coverImageUrl || item.thumbnailUrl || item.image ? (
            <Image
              src={item.coverImageUrl || item.thumbnailUrl || item.image}
              alt={item.title}
              width={500}
              height={400}
              className="object-contain max-h-full rounded-lg"
            />
          ) : (
            <div className="text-center text-gray-400">
              <FaExchangeAlt className="w-16 h-16 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No preview available</p>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-gray-500">Price</span>
          <span className="font-bold text-gray-900">
            {item.price} XLM
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Rating</span>
          <span className="font-bold text-gray-900">
            {item.rating?.toFixed(1) || "N/A"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Level</span>
          <span className="font-bold text-gray-900 capitalize">
            {item.level || "All"}
          </span>
        </div>
        {item.description && (
          <p className="text-gray-500 pt-1 border-t border-gray-100 line-clamp-3">
            {item.description}
          </p>
        )}
      </div>
    </div>
  );
}
