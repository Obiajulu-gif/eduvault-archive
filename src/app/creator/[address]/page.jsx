'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import {
  FaHeart,
  FaSearch,
  FaFilter,
  FaStar,
  FaFilePdf,
  FaGraduationCap,
  FaMapMarkerAlt,
  FaTwitter,
  FaGithub,
  FaGlobe,
  FaAward,
  FaRegComments,
  FaBook,
  FaUser,
  FaExchangeAlt,
  FaShoppingCart,
  FaWallet,
} from 'react-icons/fa';
import { motion, AnimatePresence } from 'framer-motion';
import SocialLinks from '@/components/SocialLinks';
import CopyButton from '@/components/CopyButton';
import Navbar from '@/components/Navbar';
import { useMarketplaceMaterials } from '@/hooks/api/useMaterials';
import { useCart } from '@/hooks/useCart';
import { useComparison } from '@/hooks/useComparison';
import { useUpdateProfile } from '@/hooks/api/useProfile';

export default function CreatorProfilePage() {
  const params = useParams();
  const address = String(params.address);

  // States
  const [activeTab, setActiveTab] = useState('uploads'); // 'uploads' | 'reviews' | 'about'
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('All');
  const [sortBy, setSortBy] = useState('Popular');
  const [isEditing, setIsEditing] = useState(false);
  const [editProfile, setEditProfile] = useState({});
  const [isUpdating, setIsUpdating] = useState(false);

  const { addToCart, cartItems } = useCart();
  const { addToComparison, comparedItems } = useComparison();
  const { mutateAsync: updateProfile, isPending: isUpdatingProfile } = useUpdateProfile();

  // Load profile metadata
  useEffect(() => {
    async function loadProfile() {
      try {
        setProfileLoading(true);
        const res = await fetch(`/api/profile?address=${address}`);
        if (res.ok) {
          const data = await res.json();
          if (data.exists && data.user) {
            setProfile(data.user);
          }
        }
      } catch (err) {
        console.error('Failed to load creator profile:', err);
      } finally {
        setProfileLoading(false);
      }
    }
    loadProfile();
  }, [address]);

  // Fallback to high-quality default guest creator profile if not in DB
  const creatorProfile = profile || {
    fullName: `Stellar Creator ${address.substring(0, 4)}...${address.substring(address.length - 4)}`,
    bio: 'Academic researcher and content creator. I publish premium study sheets, detailed syllabus solutions, and visual presentation slides optimized for high-performance learners on the Stellar Soroban network.',
    institution: 'Soroban Tech Academy',
    country: 'Stellar Ecosystem',
    walletAddress: address,
  };

  // Calculate profile completeness
  const profileCompleteness = () => {
    const requiredFields = [
      creatorProfile.fullName && creatorProfile.fullName.trim().length > 0,
      creatorProfile.bio && creatorProfile.bio.trim().length > 0,
      creatorProfile.institution && creatorProfile.institution.trim().length > 0,
      creatorProfile.country && creatorProfile.country.trim().length > 0,
      creatorProfile.walletAddress && creatorProfile.walletAddress.trim().length > 0,
    ];
    return Math.round((requiredFields.filter(Boolean).length / requiredFields.length) * 100);
  };

  const completenessPercentage = profileCompleteness();

  // Determine wallet status
  const walletStatus = creatorProfile.walletAddress ? 'linked' : 'not linked';

  // Handle profile update
  const handleUpdateProfile = async () => {
    setIsUpdating(true);
    try {
      const updateData = {};
      
      if (editProfile.fullName && editProfile.fullName !== creatorProfile.fullName) {
        updateData.displayName = editProfile.fullName;
      }
      
      if (editProfile.bio && editProfile.bio !== creatorProfile.bio) {
        updateData.bio = editProfile.bio;
      }
      
      if (editProfile.institution && editProfile.institution !== creatorProfile.institution) {
        updateData.institution = editProfile.institution;
      }
      
      if (editProfile.country && editProfile.country !== creatorProfile.country) {
        updateData.country = editProfile.country;
      }
      
      if (editProfile.twitterUrl !== undefined && editProfile.twitterUrl !== creatorProfile.twitterUrl) {
        updateData.twitterUrl = editProfile.twitterUrl;
      }
      
      if (editProfile.githubUrl !== undefined && editProfile.githubUrl !== creatorProfile.githubUrl) {
        updateData.githubUrl = editProfile.githubUrl;
      }
      
      if (editProfile.websiteUrl !== undefined && editProfile.websiteUrl !== creatorProfile.websiteUrl) {
        updateData.websiteUrl = editProfile.websiteUrl;
      }

      if (editProfile.discordUrl !== undefined && editProfile.discordUrl !== creatorProfile.discordUrl) {
        updateData.discordUrl = editProfile.discordUrl;
      }

      if (editProfile.telegramUrl !== undefined && editProfile.telegramUrl !== creatorProfile.telegramUrl) {
        updateData.telegramUrl = editProfile.telegramUrl;
      }
      
      if (Object.keys(updateData).length === 0) {
        setIsEditing(false);
        return;
      }
      
      await updateProfile(updateData);
      setIsEditing(false);
      setEditProfile({});
      // Refresh profile data
      const res = await fetch(`/api/profile?address=${address}`);
      if (res.ok) {
        const data = await res.json();
        if (data.exists && data.user) {
          setProfile(data.user);
        }
      }
    } catch (error) {
      console.error('Failed to update profile:', error);
      // Show error to user
    } finally {
      setIsUpdating(false);
    }
  };

  // Fetch materials for materials catalog
  // We fetch page size 50 to allow rich client-side search/filters on their catalog
  const { data: materialsData, isLoading: materialsLoading } = useMarketplaceMaterials({
    pageSize: 50,
  });

  // Client-side filter materials uploaded by this creator address
  const creatorMaterials = (materialsData?.items || []).filter((item) => {
    // Check if the material belongs to this creator
    const itemAddress = item.userAddress || item.ownerAddress;
    return (
      (itemAddress && itemAddress.toLowerCase() === address.toLowerCase()) ||
      (item.author && item.author.toLowerCase() === creatorProfile.fullName.toLowerCase())
    );
  });

  // Apply filters/sorting
  const filteredMaterials = creatorMaterials
    .filter((item) => {
      const matchesSearch =
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.description.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesSubject = selectedSubject === 'All' || item.subject === selectedSubject;
      return matchesSearch && matchesSubject;
    })
    .sort((a, b) => {
      if (sortBy === 'Price: Low to High') return Number(a.price) - Number(b.price);
      if (sortBy === 'Price: High to Low') return Number(b.price) - Number(a.price);
      if (sortBy === 'Highest Rated') return Number(b.rating || 4.8) - Number(a.rating || 4.8);
      return Number(b.likes || 0) - Number(a.likes || 0); // Popular
    });

  const materialCount = filteredMaterials.length;

  const [subjects, setSubjects] = useState(['All']);
  const [subjectsLoading, setSubjectsLoading] = useState(true);

  // Load subject categories
  useEffect(() => {
    async function loadSubjects() {
      try {
        setSubjectsLoading(true);
        const res = await fetch('/api/subjects');
        if (res.ok) {
          const data = await res.json();
          setSubjects(data.subjects || ['All']);
        }
      } catch (err) {
        console.error('Failed to load subjects:', err);
        // Fallback to default subjects
        setSubjects(['All', 'Math', 'Science', 'Law', 'Technology', 'Business', 'Medicine', 'Arts']);
      } finally {
        setSubjectsLoading(false);
      }
    }
    loadSubjects();
  }, []);

  const mockReviews = [
    {
      id: 1,
      author: 'Lucas Vance',
      major: 'Computer Science',
      rating: 5,
      comment: 'Absolutely immaculate presentation slides! The Soroban contract examples were clear and directly helped me ace my final exam.',
      date: 'May 12, 2026',
    },
    {
      id: 2,
      author: 'Elena Rostova',
      major: 'Business Law',
      rating: 5,
      comment: 'Super high-quality materials. Creator has a clear knack for summarizing extremely dense regulatory guidelines. Highly recommended.',
      date: 'April 28, 2026',
    },
    {
      id: 3,
      author: 'Marcus Aurel',
      major: 'Pre-Med Studies',
      rating: 4,
      comment: 'Extremely thorough lecture study guides. The diagrams and summaries were incredibly concise and accurate.',
      date: 'April 14, 2026',
    },
  ];

  return (
    <>
      <Navbar />

      {/* Grid Pattern Background */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70 pointer-events-none -z-10" aria-hidden="true" />

      <main className="min-h-screen bg-[#fffaf6] py-10 px-4 md:px-8 max-w-7xl mx-auto">
        {/* Creator Hero Header */}
        <motion.section
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="bg-white dark:bg-slate-900 rounded-3xl p-6 md:p-8 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col md:flex-row gap-8 items-start md:items-center mb-10 relative overflow-hidden"
        >
          {/* Decorative backdrop shape */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />

          {/* Profile Gradient Avatar */}
          <div className="relative w-24 h-24 md:w-28 md:h-28 rounded-2xl overflow-hidden shrink-0 border border-slate-100 dark:border-slate-850 flex items-center justify-center bg-gradient-to-tr from-blue-600 via-indigo-500 to-purple-500 shadow-md">
            <span className="text-3xl md:text-4xl font-extrabold text-white tracking-wider uppercase select-none">
              {creatorProfile.fullName.substring(0, 2)}
            </span>
          </div>

          {/* Info Details */}
          <div className="flex-1 space-y-4">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl md:text-2xl font-bold text-slate-800 dark:text-slate-100">
                  {creatorProfile.fullName}
                </h1>
                
                {/* Academic Badges */}
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-blue-900/60 px-2 py-0.5 rounded-full">
                    <FaAward className="w-2.5 h-2.5" />
                    Verified Educator
                  </span>
                  <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-100 dark:border-amber-900/60 px-2 py-0.5 rounded-full">
                    <FaStar className="w-2.5 h-2.5" />
                    Top Seller
                  </span>
                  {/* Trust Indicators */}
                  <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400 border border-green-100 dark:border-green-900/60 px-2 py-0.5 rounded-full">
                    <FaGraduationCap className="w-2.5 h-2.5" />
                    {completenessPercentage}% Complete
                  </span>
                  <span className={`inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${walletStatus === 'linked' ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/60' : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 border border-red-100 dark:border-red-900/60'}`}>
                    <FaWallet className="w-2.5 h-2.5" />
                    {walletStatus === 'linked' ? 'Wallet Linked' : 'No Wallet'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/60 px-2 py-0.5 rounded-full">
                    <FaBook className="w-2.5 h-2.5" />
                    {materialCount} Materials
                  </span>
                </div>
              </div>

              {/* Affiliation Indicators */}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-semibold text-slate-400 dark:text-slate-500">
                <span className="flex items-center gap-1">
                  <FaGraduationCap className="text-slate-400" />
                  {creatorProfile.institution || 'Soroban Tech Academy'}
                </span>
                <span className="flex items-center gap-1">
                  <FaMapMarkerAlt className="text-slate-400" />
                  {creatorProfile.country || 'Global Network'}
                </span>
                <span className="font-mono text-[10px] bg-slate-50 dark:bg-slate-850 px-2 py-0.5 rounded text-slate-500 border border-slate-200/40">
                  {address.substring(0, 8)}...{address.substring(address.length - 8)}
                </span>
              </div>
            </div>

            {/* Biography snippet */}
            <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400 leading-relaxed max-w-3xl">
              {creatorProfile.bio}
            </p>

            {/* Social Connect Links */}
            <SocialLinks profile={creatorProfile} className="flex items-center gap-2.5" />
          </div>
        </motion.section>

        {/* Creator Stats Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { label: 'Published', value: creatorMaterials.length, suffix: 'resources', color: 'blue' },
            { label: 'Avg Rating', value: creatorMaterials.length > 0 ? (creatorMaterials.reduce((sum, m) => sum + Number(m.rating || 4.8), 0) / creatorMaterials.length).toFixed(1) : '—', suffix: '/ 5.0', color: 'amber' },
            { label: 'Total Likes', value: creatorMaterials.reduce((sum, m) => sum + Number(m.likes || 0), 0), suffix: 'likes', color: 'rose' },
            { label: 'Profile', value: `${completenessPercentage}%`, suffix: 'complete', color: 'green' },
          ].map((stat) => (
            <div key={stat.label} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm text-center">
              <p className={`text-2xl font-extrabold text-${stat.color}-600 dark:text-${stat.color}-400`}>{stat.value}</p>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mt-1">{stat.label}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">{stat.suffix}</p>
            </div>
          ))}
        </div>

        {/* Tab Selection Navbar */}
        <nav aria-label="Creator profile tabs" className="flex border-b border-slate-200 dark:border-slate-800 mb-8 gap-6 md:gap-8 bg-white dark:bg-slate-900 p-2 rounded-2xl border border-slate-200 dark:border-slate-800/80 shadow-xs max-w-sm">
          {[
            { id: 'uploads', label: 'Uploads', icon: <FaBook /> },
            { id: 'reviews', label: 'Reviews', icon: <FaRegComments /> },
            { id: 'about', label: 'About', icon: <FaUser /> },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={isActive}
                className={`relative px-4 py-2 text-xs font-bold transition-all flex items-center gap-1.5 rounded-xl focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  isActive
                    ? 'text-blue-600 bg-blue-50 dark:bg-blue-950/40 border border-blue-100/50 dark:border-blue-900/40 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                {tab.icon}
                {tab.label}
                {tab.id === 'uploads' && creatorMaterials.length > 0 && (
                  <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/80 text-blue-700 dark:text-blue-400">
                    {creatorMaterials.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Tab content renderer */}
        <section aria-live="polite" className="relative min-h-[40vh]">
          <AnimatePresence mode="wait">
            {/* ── TAB: UPLOADS ── */}
            {activeTab === 'uploads' && (
              <motion.div
                key="uploads"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                className="space-y-8"
              >
                {/* Catalog Controls */}
                <div className="bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col lg:flex-row gap-4 items-center justify-between">
                  {/* Search */}
                  <div className="relative w-full lg:max-w-md">
                    <FaSearch className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-slate-400 w-3.5 h-3.5" />
                    <input
                      type="text"
                      placeholder="Search this creator's catalog..."
                      aria-label="Search this creator's catalog"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450 focus:bg-white text-slate-800 dark:text-slate-100 font-medium"
                    />
                  </div>

                  {/* Filters & Sorting */}
                  <div className="flex flex-wrap w-full lg:w-auto items-center gap-3 justify-end">
                    {/* Subjects filter */}
                    <div className="flex items-center bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 shrink-0">
                      <FaFilter className="text-slate-400 mr-2 text-[10px]" />
                      <select
                        value={selectedSubject}
                        onChange={(e) => setSelectedSubject(e.target.value)}
                        disabled={subjectsLoading}
                        aria-label="Filter by subject"
                        className={`bg-transparent text-xs font-semibold text-slate-650 dark:text-slate-350 focus:outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500 ${subjectsLoading ? 'opacity-50' : ''}`}
                      >
                        <option value="All">All Subjects</option>
                        {subjectsLoading ? (
                          <option value="loading" disabled>Loading subjects...</option>
                        ) : (
                          subjects.slice(1).map((sub) => (
                            <option key={sub} value={sub}>
                              {sub}
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    {/* Sorting dropdown */}
                    <div className="flex items-center bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 shrink-0">
                      <span className="text-slate-400 text-xs font-semibold mr-1.5">Sort:</span>
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                        aria-label="Sort materials"
                        className="bg-transparent text-xs font-bold text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <option>Popular</option>
                        <option>Highest Rated</option>
                        <option>Price: Low to High</option>
                        <option>Price: High to Low</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Catalog Cards Grid */}
                {materialsLoading ? (
                  <div aria-live="polite" aria-busy="true" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 animate-pulse h-64" />
                    ))}
                  </div>
                ) : filteredMaterials.length === 0 ? (
                  <div aria-live="polite" className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 py-16 px-6 text-center">
                    <div className="w-14 h-14 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4">
                      <FaBook className="text-slate-400 w-5 h-5" />
                    </div>
                    <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">
                      No materials match
                    </h3>
                    <p className="text-xs text-slate-400">
                      Try clearing filters or search to view uploads.
                    </p>
                  </div>
                ) : (
                  <div role="list" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {filteredMaterials.map((material) => {
                      const materialId = material._id || material.id;
                      const isAlreadyInCart = cartItems.some((item) => (item._id || item.id) === materialId);
                      const isAlreadyInComp = comparedItems.some((item) => (item._id || item.id) === materialId);
                      
                      return (
                        <article
                          key={materialId}
                          role="listitem"
                          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-400/40 dark:hover:border-blue-800/40 transition-all duration-300 flex flex-col group"
                        >
                          {/* Card Thumbnail */}
                          <div className="relative w-full h-32 bg-slate-100 dark:bg-slate-800 overflow-hidden border-b border-slate-100 dark:border-slate-800">
                            <Image
                              src={material.image || material.thumbnailUrl || '/images/image1.jpg'}
                              alt={material.title}
                              fill
                              className="object-cover group-hover:scale-103 transition-transform duration-500"
                            />
                            {material.subject && (
                              <span className="absolute top-2 left-2 bg-slate-900/70 dark:bg-slate-900/80 backdrop-blur-md text-white font-extrabold text-[9px] px-2 py-0.5 rounded-md uppercase tracking-wider">
                                {material.subject}
                              </span>
                            )}
                          </div>

                          {/* Card Info details */}
                          <div className="p-4 flex-1 flex flex-col">
                            <div className="flex-1 space-y-1.5 mb-4">
                              <Link
                                href={`/marketplace/${materialId}`}
                                className="text-sm font-bold text-slate-850 dark:text-slate-100 hover:text-blue-600 transition-colors line-clamp-2 leading-tight"
                              >
                                {material.title}
                              </Link>
                              <p className="text-xs text-slate-400 line-clamp-2">
                                {material.description}
                              </p>
                              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
                                <span className="flex items-center gap-1 text-[10px] text-red-500 font-bold">
                                  <FaFilePdf /> PDF
                                </span>
                                <span className="flex items-center gap-0.5">
                                  <FaStar className="text-amber-400 w-3 h-3" />
                                  <strong className="text-slate-700 dark:text-slate-200">
                                    {(material.rating || 4.8).toFixed(1)}
                                  </strong>
                                </span>
                              </div>
                            </div>

                            {/* Price / Buttons Footer */}
                            <div className="pt-3.5 border-t border-slate-100 dark:border-slate-800/80 flex flex-col gap-2">
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                  Value
                                </span>
                                <span className="text-sm font-extrabold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-2.5 py-0.5 rounded-lg border border-blue-100/50 dark:border-blue-900/20">
                                  {material.price} <span className="text-[9px] font-bold">XLM</span>
                                </span>
                              </div>

                              <div className="grid grid-cols-2 gap-1.5">
                                {/* Contrast Compare button */}
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    addToComparison(material);
                                  }}
                                  className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-bold text-[10px] transition-all border focus-visible:ring-2 focus-visible:ring-blue-500 ${
                                    isAlreadyInComp
                                      ? 'bg-amber-550 border-amber-600 text-white shadow-xs'
                                      : 'bg-white dark:bg-slate-850 hover:bg-slate-50 dark:hover:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                                  }`}
                                >
                                  <FaExchangeAlt className="w-2.5 h-2.5" />
                                  {isAlreadyInComp ? 'Contrasted' : 'Contrast'}
                                </button>

                                {/* Cart button */}
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    addToCart(material);
                                  }}
                                  className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-bold text-[10px] transition-all border focus-visible:ring-2 focus-visible:ring-blue-500 ${
                                    isAlreadyInCart
                                      ? 'bg-emerald-600 border-emerald-700 text-white shadow-xs'
                                      : 'bg-blue-600 hover:bg-blue-700 border-blue-750 text-white shadow-xs'
                                  }`}
                                >
                                  <FaShoppingCart className="w-2.5 h-2.5" />
                                  {isAlreadyInCart ? 'In Cart' : 'Add to Cart'}
                                </button>
                              </div>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}

            {/* ── TAB: REVIEWS ── */}
            {activeTab === 'reviews' && (
              <motion.div
                key="reviews"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                role="list"
                className="max-w-3xl mx-auto space-y-6"
              >
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-250 dark:border-slate-800 shadow-sm flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                      Overall Recommendation Rating
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Based on client purchases and reviews
                    </p>
                  </div>
                  <div className="text-right flex items-center gap-2">
                    <span className="text-3xl font-extrabold text-slate-800 dark:text-slate-100 leading-none">
                      4.9
                    </span>
                    <div>
                      <div className="flex text-amber-400 gap-0.5">
                        <FaStar /><FaStar /><FaStar /><FaStar /><FaStar />
                      </div>
                      <span className="text-[10px] text-slate-400 font-bold uppercase">
                        3 global reviews
                      </span>
                    </div>
                  </div>
                </div>

                {mockReviews.map((rev) => (
                  <div
                    key={rev.id}
                    role="listitem"
                      className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3.5"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">
                          {rev.author}
                        </h4>
                        <span className="text-[10px] text-slate-400 font-semibold uppercase">
                          Major: {rev.major}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="flex text-amber-400 gap-0.5 text-xs mb-0.5">
                          {Array.from({ length: rev.rating }).map((_, i) => (
                            <FaStar key={i} />
                          ))}
                        </div>
                        <span className="text-[10px] text-slate-400 font-medium">
                          {rev.date}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs md:text-sm text-slate-650 dark:text-slate-350 italic leading-relaxed font-medium">
                      &quot;{rev.comment}&quot;
                    </p>
                  </div>
                ))}
              </motion.div>
            )}

            {/* ── TAB: ABOUT ── */}
            {activeTab === 'about' && (
              <motion.div
                key="about"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                className="max-w-3xl mx-auto space-y-6"
              >
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm space-y-5">
                  <div className="space-y-2">
                    <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                      Biography
                    </h3>
                    <p className="text-xs md:text-sm text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
                      {creatorProfile.bio}
                    </p>
                  </div>

                  <hr className="border-slate-150 dark:border-slate-800" />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        Stellar Ledger Address
                      </span>
                      <p className="text-xs font-mono font-bold text-slate-700 dark:text-slate-200 truncate select-all">
                        {creatorProfile.walletAddress}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        Institutional Affiliation
                      </span>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                        {creatorProfile.institution}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        Regional Base
                      </span>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                        {creatorProfile.country}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        Academic Status
                      </span>
                      <p className="text-xs font-bold text-green-600 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                        Active Soroban Smart Contract Publisher
                      </p>
                    </div>
                  </div>
                </div>
                
                {/* Edit Profile Section */}
                <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm space-y-5">
                  <div className="flex justify-between items-center">
                    <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                      Edit Profile
                    </h3>
                    <button
                      onClick={() => setIsEditing(!isEditing)}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      {isEditing ? 'Cancel' : 'Edit Profile'}
                    </button>
                  </div>
                  
                  {isEditing && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Full Name
                        </label>
                        <input
                          type="text"
                          aria-label="Full Name"
                          value={editProfile.fullName || creatorProfile.fullName}
                          onChange={(e) => setEditProfile({...editProfile, fullName: e.target.value})}
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Biography
                        </label>
                        <textarea
                          aria-label="Biography"
                          value={editProfile.bio || creatorProfile.bio}
                          onChange={(e) => setEditProfile({...editProfile, bio: e.target.value})}
                          rows="3"
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Institutional Affiliation
                        </label>
                        <input
                          type="text"
                          aria-label="Institutional Affiliation"
                          value={editProfile.institution || creatorProfile.institution}
                          onChange={(e) => setEditProfile({...editProfile, institution: e.target.value})}
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Regional Base
                        </label>
                        <input
                          type="text"
                          aria-label="Regional Base"
                          value={editProfile.country || creatorProfile.country}
                          onChange={(e) => setEditProfile({...editProfile, country: e.target.value})}
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Twitter URL
                        </label>
                        <input
                          type="url"
                          aria-label="Twitter URL"
                          value={editProfile.twitterUrl || creatorProfile.twitterUrl || ''}
                          onChange={(e) => setEditProfile({...editProfile, twitterUrl: e.target.value})}
                          placeholder="https://twitter.com/username"
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          GitHub URL
                        </label>
                        <input
                          type="url"
                          aria-label="GitHub URL"
                          value={editProfile.githubUrl || creatorProfile.githubUrl || ''}
                          onChange={(e) => setEditProfile({...editProfile, githubUrl: e.target.value})}
                          placeholder="https://github.com/username"
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Website URL
                        </label>
                        <input
                          type="url"
                          aria-label="Website URL"
                          value={editProfile.websiteUrl || creatorProfile.websiteUrl || ''}
                          onChange={(e) => setEditProfile({...editProfile, websiteUrl: e.target.value})}
                          placeholder="https://yourwebsite.com"
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Discord
                        </label>
                        <input
                          type="url"
                          aria-label="Discord URL"
                          value={editProfile.discordUrl || creatorProfile.discordUrl || ''}
                          onChange={(e) => setEditProfile({...editProfile, discordUrl: e.target.value})}
                          placeholder="https://discord.gg/invite"
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                          Telegram
                        </label>
                        <input
                          type="url"
                          aria-label="Telegram URL"
                          value={editProfile.telegramUrl || creatorProfile.telegramUrl || ''}
                          onChange={(e) => setEditProfile({...editProfile, telegramUrl: e.target.value})}
                          placeholder="https://t.me/username"
                          className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 dark:focus:ring-blue-450"
                        />
                      </div>
                      
                      <div className="pt-4">
                        <button
                          onClick={handleUpdateProfile}
                          disabled={isUpdating}
                          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${isUpdating ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                        >
                          {isUpdating ? 'Updating...' : 'Save Changes'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>
    </>
  );
}
