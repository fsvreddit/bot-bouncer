import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { addWeeks } from "date-fns";
import { uniq } from "lodash";

async function isAppModOfSub (subredditName: string, context: TriggerContext): Promise<boolean> {
    if (subredditName === context.subredditName) {
        return true;
    }

    const redisKey = `mod:${subredditName}`;
    const isMod = await context.redis.get(redisKey);
    if (isMod) {
        return JSON.parse(isMod) as boolean;
    }

    const modList = await context.reddit.getModerators({
        subredditName,
        username: context.appName,
    }).all();

    const isModOfSub = modList.length > 0;
    await context.redis.set(redisKey, JSON.stringify(isModOfSub), { expiration: addWeeks(new Date(), 1) });

    return isModOfSub;
}

export async function isUserPotentiallyBlockingBot (history: (Post | Comment)[], context: TriggerContext): Promise<boolean> {
    const distinctSubreddits = uniq(history.map(item => item.subredditName));
    if (distinctSubreddits.length < 5) {
        return false;
    }

    for (const subredddit of distinctSubreddits) {
        const isMod = await isAppModOfSub(subredddit, context);
        if (!isMod) {
            return false;
        }
    }
    return true;
}
