import { RedisClient } from "@devvit/public-api";

const IDEMPOTENCY_LOCK_PREFIX = "idempotencyLock:";

export interface IdempotencyLockOptions {
    expiration: Date;
    verboseLogs?: boolean;
}

export function getIdempotencyLockKey (identifier: string): string {
    return `${IDEMPOTENCY_LOCK_PREFIX}${identifier}`;
}

export async function acquireIdempotencyLock (redis: RedisClient, identifier: string, options: IdempotencyLockOptions): Promise<string | undefined> {
    const redisKey = getIdempotencyLockKey(identifier);
    const txn = await redis.watch(redisKey);
    await txn.multi();

    if (await redis.exists(redisKey)) {
        if (options.verboseLogs) {
            console.log(`Idempotency: Duplicate operation for ${identifier} ignored.`);
        }
        await txn.discard();
        return;
    }

    await txn.set(redisKey, Date.now().toString(), { expiration: options.expiration });

    try {
        await txn.exec();
        return redisKey;
    } catch (error) {
        if (options.verboseLogs) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.log(`Idempotency: Duplicate operation for ${identifier} ignored: ${errorMessage}`);
        }
        return;
    }
}

export async function releaseIdempotencyLock (redis: RedisClient, redisKey: string): Promise<void> {
    await redis.del(redisKey);
}
