import { JobContext, TriggerContext, User } from "@devvit/public-api";
import { addMinutes } from "date-fns";
import { UserStatus } from "./dataStore.js";
import { PostFlairTemplate } from "./constants.js";
import { getUserOrUndefined } from "./utility.js";

const PENDING_QUEUE_KEY = "PendingQueue";

export async function addPostToPendingQueue (postId: string, username: string, context: TriggerContext) {
    await context.redis.zAdd(PENDING_QUEUE_KEY, { member: `${postId}~${username}`, score: addMinutes(new Date(), 30).getTime() });
}

export async function removePostFromPendingQueue (postId: string, username: string, context: TriggerContext) {
    await context.redis.zRem(PENDING_QUEUE_KEY, [`${postId}~${username}`]);
}

export async function processPendingQueue (_: unknown, context: JobContext) {
    const queue = await context.redis.zRange(PENDING_QUEUE_KEY, 0, new Date().getTime(), { by: "score" });
    if (queue.length === 0) {
        return;
    }

    for (const [postId, username] of queue.map(item => item.member.split("~"))) {
        const user = await getUserOrUndefined(username, context);

        if (user) {
            await addPostToPendingQueue(postId, username, context);
            console.log(`Pending Queue: ${username} is still active.`);
            continue;
        }

        // User is freshly shadowbanned, suspended, etc.
        await removePostFromPendingQueue(postId, username, context);
        const post = await context.reddit.getPostById(postId);
        const postFlair = post.flair?.text;

        const newFlair = postFlair === UserStatus.Pending ? PostFlairTemplate.Retired : PostFlairTemplate.Purged;

        await context.reddit.setPostFlair({
            postId,
            subredditName: post.subredditName,
            flairTemplateId: newFlair,
        });
    }
}
