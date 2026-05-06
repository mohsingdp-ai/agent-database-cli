import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, dbMock, collectionMock, findMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  dbMock: vi.fn(),
  collectionMock: vi.fn(),
  findMock: vi.fn()
}));

vi.mock("mongodb", () => ({
  MongoClient: vi.fn().mockImplementation(() => ({
    connect: connectMock,
    db: dbMock,
    close: vi.fn()
  }))
}));

import { MongoDbAdapter } from "../../src/adapters/mongodb.js";

describe("mongodb adapter", () => {
  beforeEach(() => {
    connectMock.mockReset();
    dbMock.mockReset();
    collectionMock.mockReset();
    findMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    dbMock.mockReturnValue({ collection: collectionMock });
    collectionMock.mockReturnValue({ find: findMock });
    findMock.mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([])
      })
    });
  });

  it("拒绝非法 limit", async () => {
    const adapter = new MongoDbAdapter("mongodb://localhost:27017/app");

    await expect(adapter.execute('{"find":{"collection":"users","limit":2000}}')).rejects.toThrow("limit");
    expect(findMock).not.toHaveBeenCalled();
  });

  it("拒绝非对象 filter", async () => {
    const adapter = new MongoDbAdapter("mongodb://localhost:27017/app");

    await expect(adapter.execute('{"find":{"collection":"users","filter":[]}}')).rejects.toThrow("filter");
    expect(findMock).not.toHaveBeenCalled();
  });

  it("拒绝非对象数组 pipeline", async () => {
    const adapter = new MongoDbAdapter("mongodb://localhost:27017/app");

    await expect(adapter.execute('{"aggregate":{"collection":"users","pipeline":[1]}}')).rejects.toThrow("pipeline");
  });
});
