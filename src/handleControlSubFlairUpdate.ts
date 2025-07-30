import { TriggerContext } from "@devvit/public-api";
import { PostFlairUpdate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { getUsernameFromUrl } from "./utility.js";
import { queueSendFeedback } from "./submissionFeedback.js";

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

    const ignoreCheck = await context.redis.exists(`ignoreflairchange:${event.post.id}`);
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

    const currentStatus = await getUserStatus(username, context);

    let operator = event.author.name;
    const overrideOperator = await context.redis.get(`userStatusOverride~${username}`);
    if (overrideOperator) {
        operator = overrideOperator;
        await context.redis.del(`userStatusOverride~${username}`);
    }

    await setUserStatus(username, {
        trackingPostId: event.post.id,
        userStatus: postFlair,
        submitter: currentStatus?.submitter,
        lastUpdate: new Date().getTime(),
        operator,
    }, context);

    console.log(`Flair Update: Status for ${username} set to ${postFlair} by ${operator}`);

    const post = await context.reddit.getPostById(event.post.id);

    // Look for Account Properties comment and delete it.
    if (postFlair !== UserStatus.Pending) {
        const comment = await post.comments.all();
        const commentToDelete = comment.find(c => c.authorName === context.appName && c.body.startsWith("## Account Properties"));

        if (commentToDelete) {
            await commentToDelete.delete();
        }

        if (post.numberOfReports > 0) {
            await context.reddit.approve(event.post.id);
        }
    }

    if (currentStatus?.userStatus === UserStatus.Pending && currentStatus.submitter && postFlair !== UserStatus.Pending) {
        await queueSendFeedback(username, context);
    }
}
