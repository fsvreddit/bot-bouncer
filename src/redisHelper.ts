import { RedisClient, ZRangeOptions } from "@devvit/public-api";
import { chunk } from "lodash";

export class RedisHelper {
    protected redis: RedisClient;

    constructor (redis: RedisClient) {
        this.redis = redis;
    }

    /**
     * Get multiple fields from a hash in Redis.
     * @param key The key of the hash.
     * @param fields The fields to retrieve.
     * @returns A promise that resolves to an object containing the field-value pairs.
     */
    public async hMGet (key: string, fields: string[]): Promise<Record<string, string>> {
        if (fields.length === 0) {
            return {};
        }

        const results: Record<string, string> = {};

        const values = await this.redis.hMGet(key, fields);

        fields.forEach((field, index) => {
            if (values[index] !== null) {
                results[field] = values[index];
            }
        });

        return results;
    }

    /**
     * Get all fields from a hash in Redis, chunking the requests if necessary.
     * @param key The key of the hash.
     * @param chunkSize The size of each chunk.
     * @returns A promise that resolves to an object containing the field-value pairs.
     */
    public async hMGetAllChunked (key: string, chunkSize = 500): Promise<Record<string, string>> {
        const fields = await this.redis.hKeys(key);
        if (fields.length === 0) {
            return {};
        }

        const results = await Promise.all(chunk(fields, chunkSize).map(c => this.hMGet(key, c)));

        return Object.assign({}, ...results) as Record<string, string>;
    }

    /**
     * Get a range of elements from a sorted set in Redis and return them as a record.
     * @param key The key of the sorted set.
     * @param start The start index (inclusive).
     * @param stop The stop index (inclusive).
     * @param options Optional additional options.
     * @returns A promise that resolves to an record with members as keys and their scores as values.
     */
    public async zRangeAsRecord (key: string, start: number | string, stop: number | string, options?: ZRangeOptions): Promise<Record<string, number>> {
        const results: Record<string, number> = {};
        const items = await this.redis.zRange(key, start, stop, options);

        items.forEach((item) => {
            results[item.member] = item.score;
        });

        return results;
    }
}
