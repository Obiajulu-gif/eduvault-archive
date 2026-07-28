import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import PayoutSettingsPanel from "../components/PayoutSettingsPanel";
import CreatorProfileSettings from "../components/CreatorProfileSettings";
import EmailPreferences from "@/components/EmailPreferences";

async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  if (!token) return null;

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const payload = jwt.verify(token, secret);
    if (!payload?.sub) return null;

    const db = await getDb();
    const users = db.collection("users");
    return users.findOne({ _id: new ObjectId(payload.sub) });
  } catch {
    return null;
  }
}

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/");
  }

  // Pass persisted email preferences to the client component so the initial
  // render is populated without an extra round-trip.
  const initialSubscriptions = user.emailSubscriptions ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-10 px-4 py-10 lg:px-8">
      <CreatorProfileSettings initialUser={user} />
      <PayoutSettingsPanel initialUser={user} />
      <EmailPreferences initialSubscriptions={initialSubscriptions} />
    </div>
  );
}
