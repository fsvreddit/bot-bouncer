import { TriggerContext, ZMember } from "@devvit/public-api";
import { getSocialLinksWithCache } from "@fsvreddit/bot-bouncer-evaluation";
import { addSeconds } from "date-fns";

const SOCIAL_LINKS_CACHE_QUEUE = "socialLinksCacheQueue";

export async function queueUsersForSocialLinksCaching (usernames: string[], context: TriggerContext) {
    if (usernames.length === 0) {
        return;
    }
    await context.redis.global.zAdd(SOCIAL_LINKS_CACHE_QUEUE, ...usernames.map(username => ({ member: username, score: Date.now() })));
}

export async function queueItemsForSocialLinksCaching (items: ZMember[], context: TriggerContext) {
    if (items.length === 0) {
        return;
    }
    await context.redis.global.zAdd(SOCIAL_LINKS_CACHE_QUEUE, ...items);
}

export async function processSocialLinksCacheQueue (context: TriggerContext) {
    const runLimit = addSeconds(new Date(), 10);
    const queue = await context.redis.global.zRange(SOCIAL_LINKS_CACHE_QUEUE, 0, -1);

    if (queue.length === 0) {
        return;
    }

    let processed = 0;

    while (queue.length > 0 && new Date() < runLimit) {
        const username = queue.shift()?.member;
        if (!username) {
            continue;
        }

        await getSocialLinksWithCache(username, context, 6);
        await context.redis.global.zRem(SOCIAL_LINKS_CACHE_QUEUE, [username]);
        processed++;
    }

    console.log(`SocialLinksCacher: Processed ${processed} users for social links caching, ${queue.length} remaining in queue.`);
}
