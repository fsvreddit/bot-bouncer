import { redis, RedisClient, ZRangeOptions } from "@devvit/web/server";
import { differenceInSeconds } from "date-fns";
import chunk from "lodash/chunk";

/**
 * Retrieves multiple fields from a Redis hash and returns them as a record/object.
 * @param {RedisClient} redis An instance of Devvit's Redis client.
 * @param key The key of the hash.
 * @param fields The fields to retrieve values for
 * @returns  {Record<string, string>} An object with field-value pairs for the specified fields.
 */
export async function hMGetAsRecord (redis: RedisClient, key: string, fields: string[]): Promise<Record<string, string>> {
    if (fields.length === 0) {
        return {};
    }

    const results: Record<string, string> = {};

    const values = await redis.hMGet(key, fields);

    fields.forEach((field, index) => {
        const value = values[index];
        if (value) {
            results[field] = value;
        }
    });

    return results;
}

/**
 * Get all entries from a hash in Redis, chunking the requests if necessary to avoid exceeding Devvit's limitations on response size.
 * @param {RedisClient} redis An instance of Devvit's Redis client.
 * @param key The key of the hash.
 * @param chunkSize The size of each chunk.
 * @returns {Record<string, string>} An object with field-value pairs for the specified fields.
 */
export async function hGetAllChunked (redis: RedisClient, key: string, chunkSize = 5000): Promise<Record<string, string>> {
    const fields = await redis.hKeys(key);
    if (fields.length === 0) {
        return {};
    }

    const results = await Promise.all(chunk(fields, chunkSize).map(c => hMGetAsRecord(redis, key, c)));

    return Object.assign({}, ...results) as Record<string, string>;
}

export async function hSetChunked (redis: RedisClient, key: string, fieldValues: Record<string, string>, batchSize = 5000): Promise<void> {
    const chunkedEntries = chunk(Object.entries(fieldValues), batchSize);
    for (const chunk of chunkedEntries) {
        const chunkedFieldValues = Object.fromEntries(chunk);
        await redis.hSet(key, chunkedFieldValues);
    }
}

/**
 * Sets an expiration time on a Redis key based on a Date object.
 * @param key The redis key.
 * @param expireAt The expiration date.
 */
export async function expireKeyAt (key: string, expireAt: Date) {
    const secondsUntil = differenceInSeconds(expireAt, new Date());
    if (secondsUntil > 0) {
        await redis.expire(key, secondsUntil);
    } else {
        throw new Error(`Expire time ${expireAt.toISOString()} is in the past`);
    }
}

/**
 * Returns a range of members from a sorted set in Redis as a record/object, where the keys are the members and the values are their scores.
 * @param {RedisClient} redis An instance of Devvit's Redis client.
 * @param key The key of the sorted set.
 * @param start The starting index (inclusive) of the range.
 * @param stop The ending index (exclusive) of the range.
 * @param options Optional parameters for the zRange command.
 * @returns {Record<string, number>} A record/object with members and their scores.
 */
export async function zRangeAsRecord (redis: RedisClient, key: string, start: number | string, stop: number | string, options?: ZRangeOptions): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    const items = await redis.zRange(key, start, stop, options);

    items.forEach((item) => {
        results[item.member] = item.score;
    });

    return results;
}
