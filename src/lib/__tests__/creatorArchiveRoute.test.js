import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as archivePost } from "@/app/api/creator/materials/[id]/archive/route";
import * as authMod from "@/lib/api/auth";
import * as mongoMod from "@/lib/mongodb";
import { ObjectId } from "mongodb";

describe("Creator Materials Archive Route (Issue #560)", () => {
  let mockMaterialsCollection;
  let mockDb;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockMaterialsCollection = {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    };
    mockDb = {
      collection: vi.fn().mockReturnValue(mockMaterialsCollection),
    };
    vi.spyOn(mongoMod, "getDb").mockResolvedValue(mockDb);
  });

  it("denies unauthenticated request with 401", async () => {
    vi.spyOn(authMod, "getUserFromCookie").mockResolvedValue(null);

    const req = new Request("http://localhost:3000/api/creator/materials/123/archive", {
      method: "POST",
      body: JSON.stringify({ archived: true }),
    });

    const res = await archivePost(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 if material is not found", async () => {
    vi.spyOn(authMod, "getUserFromCookie").mockResolvedValue({ walletAddress: "GCREATOR" });
    mockMaterialsCollection.findOne.mockResolvedValue(null);

    const id = new ObjectId().toString();
    const req = new Request(`http://localhost:3000/api/creator/materials/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true }),
    });

    const res = await archivePost(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it("denies non-owner with 403", async () => {
    vi.spyOn(authMod, "getUserFromCookie").mockResolvedValue({ walletAddress: "GATTACKER" });
    const id = new ObjectId().toString();
    mockMaterialsCollection.findOne.mockResolvedValue({
      _id: new ObjectId(id),
      userAddress: "GREALOWNER",
      title: "Math 101",
    });

    const req = new Request(`http://localhost:3000/api/creator/materials/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true }),
    });

    const res = await archivePost(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(403);
  });

  it("successfully archives material for owner", async () => {
    const owner = "GOWNER123";
    vi.spyOn(authMod, "getUserFromCookie").mockResolvedValue({ walletAddress: owner });
    const id = new ObjectId().toString();
    mockMaterialsCollection.findOne.mockResolvedValue({
      _id: new ObjectId(id),
      userAddress: owner,
      title: "Math 101",
    });
    mockMaterialsCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const req = new Request(`http://localhost:3000/api/creator/materials/${id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    const res = await archivePost(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.archived).toBe(true);
    expect(mockMaterialsCollection.updateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(id) },
      expect.objectContaining({
        $set: expect.objectContaining({ archived: true, updatedBy: owner }),
      })
    );
  });

  it("successfully restores material for owner", async () => {
    const owner = "GOWNER123";
    vi.spyOn(authMod, "getUserFromCookie").mockResolvedValue({ walletAddress: owner });
    const id = new ObjectId().toString();
    mockMaterialsCollection.findOne.mockResolvedValue({
      _id: new ObjectId(id),
      userAddress: owner,
      archived: true,
      title: "Math 101",
    });
    mockMaterialsCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const req = new Request(`http://localhost:3000/api/creator/materials/${id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });

    const res = await archivePost(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.archived).toBe(false);
    expect(mockMaterialsCollection.updateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(id) },
      expect.objectContaining({
        $set: expect.objectContaining({ archived: false, archivedAt: null }),
      })
    );
  });
});
