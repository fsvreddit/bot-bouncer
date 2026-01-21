import { JobContext, SubredditInfo } from "@devvit/public-api";

const SUB_EXISTENCE_CACHE_KEY = "subExistenceCache";

async function subExists (sub: string, context: JobContext): Promise<boolean> {
    let subInfo: SubredditInfo;
    try {
        subInfo = await context.reddit.getSubredditInfoByName(sub);
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

export async function checkNonexistentSubs (subreddits: string[], context: JobContext): Promise<string[]> {
    const uniqueSubs = Array.from(new Set(subreddits));
    if (uniqueSubs.length === 0) {
        return [];
    }

    const subsThatExist = await context.redis.hKeys(SUB_EXISTENCE_CACHE_KEY).then(keys => new Set(keys));

    for (const sub of uniqueSubs.filter(sub => !subsThatExist.has(sub))) {
        console.log(`Sub Existence Check: Subreddit r/${sub} does not exist in cache.`);
        if (await subExists(sub, context)) {
            await context.redis.hSet(SUB_EXISTENCE_CACHE_KEY, { [sub]: "exists" });
            subsThatExist.add(sub);
        }
    }

    return uniqueSubs.filter(sub => !subsThatExist.has(sub));
}
