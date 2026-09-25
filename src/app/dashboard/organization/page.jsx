import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { unstable_cache } from "next/cache";

const getCachedUser = unstable_cache(
    async (id) => {
        const db = await getDb();
        const users = db.collection("users");
        return users.findOne({ _id: new ObjectId(id) });
    },
    ["user-by-id"],
    { revalidate: 60 }
);

export default async function OrganizationDashboardPage() {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    if (!token) {
        redirect("/");
    }

    let payload;
    try {
        const secret = process.env.JWT_SECRET;
        payload = jwt.verify(token, secret);
    } catch (e) {
        redirect("/");
    }

    const user = await getCachedUser(payload.sub);
    if (!user) {
        redirect("/");
    }

    return (
        <div className="space-y-8 max-w-7xl mx-auto pb-10">
            <header className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col md:flex-row items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Organization Dashboard</h1>
                    <p className="text-gray-500">Manage your institution, members, and shared resources.</p>
                </div>
                <div className="flex gap-3">
                    <button className="px-4 py-2 bg-blue-50 text-blue-600 font-semibold rounded-lg text-sm hover:bg-blue-100 transition">
                        Invite Member
                    </button>
                    <button className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg text-sm hover:bg-blue-700 transition">
                        Organization Settings
                    </button>
                </div>
            </header>

            <div className="grid lg:grid-cols-3 gap-8 items-start">
                <div className="lg:col-span-2 space-y-8">
                    <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                        <h2 className="text-lg font-bold text-gray-900 mb-4">Organization Overview</h2>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div className="p-4 bg-gray-50 rounded-xl">
                                <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Total Members</p>
                                <p className="text-2xl font-bold text-gray-900 mt-1">12</p>
                            </div>
                            <div className="p-4 bg-gray-50 rounded-xl">
                                <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Active Materials</p>
                                <p className="text-2xl font-bold text-gray-900 mt-1">45</p>
                            </div>
                            <div className="p-4 bg-gray-50 rounded-xl">
                                <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Total Views</p>
                                <p className="text-2xl font-bold text-gray-900 mt-1">1.2k</p>
                            </div>
                            <div className="p-4 bg-gray-50 rounded-xl">
                                <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Revenue (XLM)</p>
                                <p className="text-2xl font-bold text-gray-900 mt-1">3,450</p>
                            </div>
                        </div>
                    </section>

                    <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-lg font-bold text-gray-900">Members</h2>
                            <button className="text-sm text-blue-600 font-semibold hover:underline">View All</button>
                        </div>
                        <div className="space-y-4">
                            {/* Member List Placeholder */}
                            {[1, 2, 3].map(i => (
                                <div key={i} className="flex items-center justify-between p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold">
                                            M{i}
                                        </div>
                                        <div>
                                            <p className="font-semibold text-gray-900">Member {i}</p>
                                            <p className="text-xs text-gray-500">member{i}@organization.edu</p>
                                        </div>
                                    </div>
                                    <span className="px-3 py-1 bg-green-50 text-green-700 text-xs font-semibold rounded-full border border-green-200">
                                        Active
                                    </span>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                <div className="space-y-8">
                    <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                        <h2 className="text-lg font-bold text-gray-900 mb-4">Resource Activity</h2>
                        <div className="space-y-4">
                            <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                                <p className="text-sm font-semibold text-gray-900">Advanced Calculus Notes</p>
                                <p className="text-xs text-gray-500 mt-1">Published 2 hours ago by Member 1</p>
                            </div>
                            <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                                <p className="text-sm font-semibold text-gray-900">Physics Lab Manual</p>
                                <p className="text-xs text-gray-500 mt-1">Updated 5 hours ago by Member 2</p>
                            </div>
                            <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                                <p className="text-sm font-semibold text-gray-900">Economics 101 Slides</p>
                                <p className="text-xs text-gray-500 mt-1">Reviewed yesterday by Member 3</p>
                            </div>
                        </div>
                        <button className="w-full mt-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50 transition">
                            View Activity Log
                        </button>
                    </section>
                </div>
            </div>
        </div>
    );
}
