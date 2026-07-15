import { RedisClient } from "@devvit/public-api";
import { acquireIdempotencyLock, getIdempotencyLockKey, releaseIdempotencyLock } from "./idempotency.js";

interface FakeTransaction {
    multi: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
}

function makeRedis (existing = false, failExec = false) {
    const transaction: FakeTransaction = {
        multi: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        exec: failExec ? vi.fn().mockRejectedValue(new Error("conflict")) : vi.fn().mockResolvedValue(undefined),
        discard: vi.fn().mockResolvedValue(undefined),
    };
    const redis = {
        watch: vi.fn().mockResolvedValue(transaction),
        exists: vi.fn().mockResolvedValue(existing),
        del: vi.fn().mockResolvedValue(undefined),
    } as unknown as RedisClient;

    return { redis, transaction };
}

test("acquires an idempotency lock atomically", async () => {
    const { redis, transaction } = makeRedis();
    const expiration = new Date(Date.now() + 60_000);

    const lockKey = await acquireIdempotencyLock(redis, "summary:t3_test", { expiration });

    expect(lockKey).toBe(getIdempotencyLockKey("summary:t3_test"));
    expect(redis.watch).toHaveBeenCalledWith(lockKey);
    expect(transaction.set).toHaveBeenCalledWith(lockKey, expect.any(String), { expiration });
    expect(transaction.exec).toHaveBeenCalledOnce();
});

test("does not acquire an existing idempotency lock", async () => {
    const { redis, transaction } = makeRedis(true);

    const lockKey = await acquireIdempotencyLock(redis, "summary:t3_test", {
        expiration: new Date(Date.now() + 60_000),
    });

    expect(lockKey).toBeUndefined();
    expect(transaction.discard).toHaveBeenCalledOnce();
    expect(transaction.set).not.toHaveBeenCalled();
});

test("treats a transaction conflict as a duplicate operation", async () => {
    const { redis } = makeRedis(false, true);

    const lockKey = await acquireIdempotencyLock(redis, "summary:t3_test", {
        expiration: new Date(Date.now() + 60_000),
    });

    expect(lockKey).toBeUndefined();
});

test("releases an idempotency lock for retry", async () => {
    const { redis } = makeRedis();
    const lockKey = getIdempotencyLockKey("summary:t3_test");

    await releaseIdempotencyLock(redis, lockKey);

    expect(redis.del).toHaveBeenCalledWith(lockKey);
});
