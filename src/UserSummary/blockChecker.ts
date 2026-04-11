import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { addWeeks } from "date-fns";
import { isModerator } from "devvit-helpers";
import _ from "lodash";

async function isAppModOfSub (subredditName: string, context: TriggerContext): Promise<boolean> {
    if (subredditName === context.subredditName) {
        return true;
    }

    const redisKey = `mod:${subredditName}`;
    const isMod = await context.redis.get(redisKey);
    if (isMod) {
        return JSON.parse(isMod) as boolean;
    }

    const isModOfSub = await isModerator(context.reddit, subredditName, context.appSlug);

    await context.redis.set(redisKey, JSON.stringify(isModOfSub), { expiration: addWeeks(new Date(), 1) });

    return isModOfSub;
}

export async function isUserPotentiallyBlockingBot (history: (Post | Comment)[], context: TriggerContext): Promise<boolean | undefined> {
    const relevantHistory = history.filter(item => !item.stickied && item.subredditName !== `u_${item.authorName}`);
    const distinctSubreddits = _.uniq(relevantHistory.map(item => item.subredditName));
    if (distinctSubreddits.length < 5) {
        return;
    }

    for (const subredddit of distinctSubreddits) {
        const isMod = await isAppModOfSub(subredddit, context);
        if (!isMod) {
            return false;
        }
    }
    return true;
}
