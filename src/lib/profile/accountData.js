import { ObjectId } from "mongodb";
import { escapeRegExp } from "@/lib/api/validation";

const NO_MATCH = { __eduvaultNoMatch: true };

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

export function getWalletAddresses(user) {
  return unique([
    user?.walletAddress,
    user?.walletAddressLower,
    user?.address,
    user?.publicKey,
  ]);
}

export function getUserQuery(sessionUser, walletAddress) {
  const idCandidates = [sessionUser?.sub, sessionUser?._id]
    .filter((value) => ObjectId.isValid(value))
    .map((value) => new ObjectId(String(value)));
  const addresses = unique([walletAddress, ...getWalletAddresses(sessionUser)]);

  const clauses = [
    ...idCandidates.map((id) => ({ _id: id })),
    ...addresses.map((address) => ({
      $or: [
        { walletAddress: address },
        { walletAddressLower: address.toLowerCase() },
        {
          walletAddress: {
            $regex: `^${escapeRegExp(address)}$`,
            $options: "i",
          },
        },
      ],
    })),
  ];

  if (clauses.length === 0) return NO_MATCH;
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

export function buildWalletQuery(field, addresses) {
  const values = unique(addresses);
  if (values.length === 0) return null;
  return {
    $or: values.map((value) => ({
      [field]: { $regex: `^${escapeRegExp(value)}$`, $options: "i" },
    })),
  };
}

export function getUserIdString(user) {
  if (!user) return "unknown";
  if (user.sub) return String(user.sub);
  if (user._id) return String(user._id);
  return getWalletAddresses(user)[0] || "unknown";
}
