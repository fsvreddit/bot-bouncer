import { Comment, context, Post, redis } from "@devvit/web/server";
import { isModerator } from "../..";
import { addWeeks } from "date-fns";
import _ from "lodash";

async function isAppModOfSub (subredditName: string): Promise<boolean> {
    if (subredditName === context.subredditName) {
        return true;
    }

    const redisKey = `modOfSub:${subredditName}`;
    const isMod = await redis.get(redisKey);
    if (isMod) {
        return JSON.parse(isMod) as boolean;
    }

    const isModOfSub = await isModerator(subredditName, context.appSlug);

    await redis.set(redisKey, JSON.stringify(isModOfSub), { expiration: addWeeks(new Date(), 1) });

    return isModOfSub;
}

export async function isUserPotentiallyBlockingBot (history: (Post | Comment)[]): Promise<boolean | undefined> {
    const relevantHistory = history.filter(item => !item.stickied && item.subredditName !== `u_${item.authorName}`);
    const distinctSubreddits = _.uniq(relevantHistory.map(item => item.subredditName));
    if (distinctSubreddits.length < 5) {
        return;
    }

    for (const subreddit of distinctSubreddits) {
        const isMod = await isAppModOfSub(subreddit);
        if (!isMod) {
            return false;
        }
    }
    return true;
}
