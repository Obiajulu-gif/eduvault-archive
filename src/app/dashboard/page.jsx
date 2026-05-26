import WelcomeBanner from "./components/WelcomeBanner";
import EarningsSection from "./components/EarningsSection";
import TrendingMaterials from "./components/TrendingMaterials";
import LatestActivity from "./components/LatestActivity";
import TopCreators from "./components/TopCreators";
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

export default async function DashboardPage() {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    if (!token) {
        redirect("/");
    }

    let payload;
    try {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            throw new Error("JWT_SECRET not configured");
        }
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
            {/* Top Row: Welcome & Call to Action */}
            <WelcomeBanner user={user} />

            {/* Second Row: Integrated Metrics Spread */}
            <EarningsSection />

            {/* Main Content Split: Creator Focus vs Discovery */}
            <div className="grid lg:grid-cols-3 gap-8 items-start">
                
                {/* Left Column (Creator Focus - 2/3 width) */}
                <div className="lg:col-span-2 space-y-8">
                    <LatestActivity />
                    {/* Placeholder for future performance charts could go here */}
                </div>

                {/* Right Column (Discovery Focus - 1/3 width) */}
                <div className="space-y-8">
                    <TrendingMaterials />
                    <TopCreators />
                </div>
            </div>
        </div>
    );
}
