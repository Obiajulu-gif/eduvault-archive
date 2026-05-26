import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

function readAuthToken(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  return cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
}

async function resolveWalletAddress(db, payload) {
  const directAddress = payload?.walletAddress || payload?.address || null;
  if (directAddress) {
    return directAddress;
  }

  if (!db || !payload?.sub || !ObjectId.isValid(payload.sub)) {
    return null;
  }

  const user = await db.collection("users").findOne({ _id: new ObjectId(payload.sub) });
  return user?.walletAddress || user?.walletAddressLower || null;
}

export async function getAuthenticatedSession(request, { db } = {}) {
  const token = readAuthToken(request);
  if (!token || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const walletAddress = await resolveWalletAddress(db, payload);

    return {
      ...payload,
      walletAddress,
      walletAddressLower: walletAddress ? walletAddress.toLowerCase() : null,
    };
  } catch {
    return null;
  }
}
