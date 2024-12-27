import { TriggerContext } from "@devvit/public-api";
import { PostFlairUpdate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { setUserStatus, UserStatus } from "./dataStore.js";
import { getUsernameFromUrl } from "./utility.js";

export async function handleControlSubFlairUpdate (event: PostFlairUpdate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.author?.name || !event.post) {
        return;
    }

    const appUser = await context.reddit.getAppUser();

    if (event.post.authorId !== appUser.id) {
        return;
    }

    const postFlair = event.post.linkFlair?.text as UserStatus | undefined;
    if (!postFlair) {
        return;
    }

    const ignoreCheck = await context.redis.get(`ignoreflairchange:${event.post.id}`);
    if (ignoreCheck) {
        return;
    }

    const username = getUsernameFromUrl(event.post.url);
    if (!username) {
        return;
    }

    if (!Object.values(UserStatus).includes(postFlair)) {
        return;
    }

    await setUserStatus(username, {
        trackingPostId: event.post.id,
        userStatus: postFlair,
        lastUpdate: new Date().getTime(),
        operator: event.author.name,
    }, context);

    console.log(`Status for ${username} set to ${postFlair} by ${event.author.name}`);

    await context.reddit.approve(event.post.id);
}
