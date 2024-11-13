import { TriggerContext } from "@devvit/public-api";
import { PostFlairUpdate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { setUserStatus, UserStatus } from "./dataStore.js";
import { getUsernameFromUrl } from "./utility.js";

export async function handleBackroomFlairUpdate (event: PostFlairUpdate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.author?.name || !event.post) {
        return;
    }

    const postFlair = event.post.linkFlair?.text as UserStatus | undefined;
    if (!postFlair) {
        return;
    }

    const username = getUsernameFromUrl(event.post.url);
    if (!username) {
        return;
    }

    if (Object.keys(UserStatus).includes(postFlair) || postFlair === UserStatus.Pending) {
        return;
    }

    await setUserStatus(username, {
        trackingPostId: event.post.id,
        userStatus: postFlair,
        lastUpdate: new Date().getTime(),
        operator: event.author.name,
    }, context);

    console.log(`Status for ${username} set to ${postFlair} by ${event.author.name}`);
}
