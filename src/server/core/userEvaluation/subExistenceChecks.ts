import { reddit, redis, SubredditInfo } from "@devvit/web/server";

const SUB_EXISTENCE_CACHE_KEY = "subExistenceCache";

async function subExists (sub: string): Promise<boolean> {
    let subInfo: SubredditInfo;
    try {
        subInfo = await reddit.getSubredditInfoByName(sub);
    } catch {
        console.log(`Sub Existence Check: Subreddit r/${sub} does not exist.`);
        return false;
    }

    if (subInfo.type === "private" || subInfo.type === "employees_only") {
        console.log(`Sub Existence Check: Subreddit r/${sub} is private or employees only.`);
        return false;
    }

    return true;
}

export async function checkNonexistentSubs (subreddits: string[]): Promise<string[]> {
    const uniqueSubs = Array.from(new Set(subreddits));
    if (uniqueSubs.length === 0) {
        return [];
    }

    const subsThatExist = await redis.hKeys(SUB_EXISTENCE_CACHE_KEY).then(keys => new Set(keys));

    for (const sub of uniqueSubs.filter(sub => !subsThatExist.has(sub))) {
        console.log(`Sub Existence Check: Subreddit r/${sub} does not exist in cache.`);
        if (await subExists(sub)) {
            await redis.hSet(SUB_EXISTENCE_CACHE_KEY, { [sub]: "exists" });
            subsThatExist.add(sub);
        }
    }

    return uniqueSubs.filter(sub => !subsThatExist.has(sub));
}
