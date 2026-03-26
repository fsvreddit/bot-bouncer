import { RedisClient } from "@devvit/public-api";
import { chunk } from "lodash";

export async function hSetChunked (redis: RedisClient, key: string, fieldValues: Record<string, string>, batchSize = 5000): Promise<void> {
    const chunkedEntries = chunk(Object.entries(fieldValues), batchSize);
    for (const chunk of chunkedEntries) {
        const chunkedFieldValues = Object.fromEntries(chunk);
        await redis.hSet(key, chunkedFieldValues);
    }
}
