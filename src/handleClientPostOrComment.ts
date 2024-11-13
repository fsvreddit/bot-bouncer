import { TriggerContext, User } from "@devvit/public-api";
import { CommentSubmit, PostSubmit } from "@devvit/protos";
import { getUserStatus, recordBan, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { isApproved, isBanned, isModerator } from "./utility.js";

export async function handleClientPostSubmit (event: PostSubmit, context: TriggerContext) {
    if (!event.post || !event.author?.name) {
        return;
    }

    await handleContentCreation(event.author.name, event.post.id, context);
}

export async function handleClientCommentSubmit (event: CommentSubmit, context: TriggerContext) {
    if (!event.comment || !event.author?.name) {
        return;
    }

    await handleContentCreation(event.author.name, event.comment.id, context);
}

async function handleContentCreation (username: string, targetId: string, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus || currentStatus.userStatus !== UserStatus.Banned) {
        return;
    }

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    let user: User | undefined;
    try {
        user = await context.reddit.getUserById(username);
    } catch {
        //
    }

    if (!user) {
        // Unusual, but user may have been shadowbanned before getting to this point.
        return;
    }

    const flair = await user.getUserFlairBySubreddit(subredditName);
    const flairText = flair?.flairText;

    if (flairText?.toLowerCase().endsWith("proof")) {
        console.log(`${user.username} is whitelisted via flair`);
        return;
    }

    if (await isApproved(user.username, context)) {
        console.log(`${user.username} is whitelisted as an approved user`);
        return;
    }

    if (await isModerator(user.username, context)) {
        console.log(`${user.username} is whitelisted as a moderator`);
        return;
    }

    await context.reddit.remove(targetId, true);

    if (!(await isBanned(user.username, context))) {
        await context.reddit.banUser({
            subredditName,
            username: user.username,
            context: targetId,
        });

        await recordBan(username, context);
    }
}
