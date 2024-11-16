import { TriggerContext, User } from "@devvit/public-api";
import { CommentSubmit, PostSubmit } from "@devvit/protos";
import { formatDate } from "date-fns";
import { getUserStatus, recordBan, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserOrUndefined, isApproved, isBanned, isModerator, replaceAll } from "./utility.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";

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

    const user = await getUserOrUndefined(username, context);

    if (!user) {
        // Unusual, but user may have been shadowbanned before getting to this point.
        return;
    }

    const flair = await user.getUserFlairBySubreddit(subredditName);
    if (flair?.flairCssClass?.toLowerCase().endsWith("proof")) {
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

    const isCurrentlyBanned = await isBanned(user.username, context);

    if (!isCurrentlyBanned) {
        let message = await context.settings.get<string>(AppSetting.BanMessage) ?? CONFIGURATION_DEFAULTS.banMessage;
        message = replaceAll(message, "{subreddit}", subredditName);
        message = replaceAll(message, "{account}", user.username);
        message = replaceAll(message, "{link}", user.username);

        let banNote = CONFIGURATION_DEFAULTS.banNote;
        banNote = replaceAll(banNote, "{me}", context.appName);
        banNote = replaceAll(banNote, "{date}", formatDate(new Date(), "yyyy-MM-dd"));

        await context.reddit.banUser({
            subredditName,
            username: user.username,
            context: targetId,
            message,
            note: banNote,
        });

        await recordBan(username, context);
    }
}
