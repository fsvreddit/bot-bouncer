import { Post, Comment, TriggerContext } from "@devvit/public-api";
import { CommentSubmit, PostSubmit } from "@devvit/protos";
import { addDays, addMinutes, formatDate, subMinutes } from "date-fns";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { isUserWhitelisted, recordBan } from "./handleClientSubredditWikiUpdate.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getPostOrCommentById, getUserOrUndefined, isApproved, isBanned, isModerator, replaceAll } from "./utility.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";
import { addExternalSubmission } from "./externalSubmissions.js";

export async function handleClientPostSubmit (event: PostSubmit, context: TriggerContext) {
    if (!event.post || !event.author?.name) {
        return;
    }

    await handleContentCreation(event.author.name, event.post.id, context);

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        return;
    }

    const post = await context.reddit.getPostById(event.post.id);
    let possibleBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context);
        if (evaluator.preEvaluatePost(post)) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, context);
    }
}

export async function handleClientCommentSubmit (event: CommentSubmit, context: TriggerContext) {
    if (!event.comment || !event.author?.name) {
        return;
    }

    await handleContentCreation(event.author.name, event.comment.id, context);

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        await checkForBotMentions(event, context);
        return;
    }

    let possibleBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context);
        if (evaluator.preEvaluateComment(event)) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
        return;
    }

    const redisKey = `lastcheck:${event.author.name}`;
    const recentlyChecked = await context.redis.get(redisKey);
    if (recentlyChecked) {
        // Allow some rechecks within 15 minutes, to find rapid fire bots.
        const lastCheck = new Date(parseInt(recentlyChecked));
        if (lastCheck < subMinutes(new Date(), 15)) {
            return;
        }
    }

    await checkAndReportPotentialBot(event.author.name, context);

    await context.redis.set(redisKey, new Date().getTime.toString(), { expiration: addDays(new Date(), 2) });
}

async function handleContentCreation (username: string, targetId: string, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus || currentStatus.userStatus !== UserStatus.Banned) {
        return;
    }

    const userWhitelisted = await isUserWhitelisted(username, context);
    if (userWhitelisted) {
        console.log(`${username} is whitelisted after a previous unban, so will not be actioned.`);
    }

    console.log(`Status for ${username} is ${currentStatus.userStatus}`);

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    const user = await getUserOrUndefined(username, context);

    if (!user) {
        console.log(`${username} appears to be shadowbanned.`);
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

async function checkAndReportPotentialBot (username: string, context: TriggerContext) {
    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return;
    }

    let userEligible = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context);
        if (evaluator.preEvaluateUser(user)) {
            userEligible = true;
            break;
        }
    }

    if (!userEligible) {
        return;
    }

    let userItems: (Post | Comment)[];
    try {
        userItems = await context.reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            limit: 100,
        }).all();
    } catch {
        // Error retrieving user history, likely shadowbanned.
        return;
    }

    let isLikelyBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context);
        if (evaluator.evaluate(user, userItems)) {
            isLikelyBot = true;
            break;
        }
    }

    if (!isLikelyBot) {
        return;
    }

    const isMod = await isModerator(user.username, context);
    if (isMod) {
        return;
    }

    const currentUser = await context.reddit.getCurrentUser();

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
    await addExternalSubmission(user.username, currentUser?.username, `Automatically reported via a post or comment on /r/${subredditName}`, context);

    console.log(`Created external submission via automated evaluation for ${user.username}`);
}

async function checkForBotMentions (event: CommentSubmit, context: TriggerContext) {
    const botRegex = [
        /\bbots?\b/i,
        /\bChatGPT\b/i,
    ];

    const commentBody = event.comment?.body;
    const parentId = event.comment?.parentId;
    if (!commentBody || !parentId) {
        return;
    }

    if (!botRegex.some(regex => regex.test(commentBody))) {
        return;
    }

    const parentItem = await getPostOrCommentById(parentId, context);

    await context.redis.set(`botmention:${parentItem.id}`, parentItem.authorName, { expiration: addMinutes(new Date(), 5) });
}
