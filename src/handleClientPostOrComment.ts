import { Post, Comment, TriggerContext, SettingsValues } from "@devvit/public-api";
import { CommentCreate, PostCreate } from "@devvit/protos";
import { addDays, addMinutes, addWeeks, formatDate, subMinutes } from "date-fns";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { isUserWhitelisted, recordBan } from "./handleClientSubredditWikiUpdate.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getPostOrCommentById, getUserOrUndefined, isApproved, isBanned, isModerator, replaceAll } from "./utility.js";
import { AppSetting, CONFIGURATION_DEFAULTS, getControlSubSettings } from "./settings.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";
import { addExternalSubmission } from "./externalSubmissions.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";

export async function handleClientPostCreate (event: PostCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.post || !event.author?.name) {
        return;
    }

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    await handleContentCreation(event.author.name, event.post.id, context);

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        return;
    }

    const settings = await context.settings.getAll();
    if (!settings[AppSetting.ReportPotentialBots]) {
        return;
    }

    const variables = await getEvaluatorVariables(context);

    const post = await context.reddit.getPostById(event.post.id);
    let possibleBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.preEvaluatePost(post)) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, event.post.id, settings, context);
    }
}

export async function handleClientCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.comment || !event.author?.name) {
        return;
    }

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    await handleContentCreation(event.author.name, event.comment.id, context);

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        return;
    }

    const settings = await context.settings.getAll();
    if (!settings[AppSetting.ReportPotentialBots]) {
        return;
    }

    const variables = await getEvaluatorVariables(context);

    let possibleBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.preEvaluateComment(event)) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
        await checkForBotMentions(event, context);
        return;
    }

    const redisKey = `lastbotcheck:${event.author.name}`;
    const recentlyChecked = await context.redis.get(redisKey);
    if (recentlyChecked) {
        // Allow some rechecks within 15 minutes, to find rapid fire bots.
        const lastCheck = new Date(parseInt(recentlyChecked));
        if (lastCheck < subMinutes(new Date(), 15)) {
            return;
        }
    }

    await checkAndReportPotentialBot(event.author.name, event.comment.id, settings, context);

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

async function handleContentCreation (username: string, targetId: string, context: TriggerContext) {
    const currentStatus = await getUserStatus(username, context);
    if (currentStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    const userWhitelisted = await isUserWhitelisted(username, context);
    if (userWhitelisted) {
        console.log(`${username} is whitelisted after a previous unban, so will not be actioned.`);
    }

    console.log(`Content Create: Status for ${username} is ${currentStatus.userStatus}`);

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    const user = await getUserOrUndefined(username, context);

    if (!user) {
        console.log(`Content Create: ${username} appears to be shadowbanned.`);
        return;
    }

    const flair = await user.getUserFlairBySubreddit(subredditName);
    if (flair?.flairCssClass?.toLowerCase().endsWith("proof")) {
        console.log(`Content Create: ${user.username} is whitelisted via flair`);
        return;
    }

    if (await isApproved(user.username, context)) {
        console.log(`Content Create: ${user.username} is whitelisted as an approved user`);
        return;
    }

    if (await isModerator(user.username, context)) {
        console.log(`Content Create: ${user.username} is whitelisted as a moderator`);
        return;
    }

    await context.reddit.remove(targetId, true);
    console.log(`Content Create: ${targetId} removed for ${user.username}`);

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
        console.log(`Content Create: ${user.username} banned from ${subredditName}`);
    }
}

async function checkAndReportPotentialBot (username: string, thingId: string, settings: SettingsValues, context: TriggerContext) {
    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return;
    }

    const variables = await getEvaluatorVariables(context);

    let userEligible = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
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
        console.log(`Bot check: couldn't read history for ${username}.`);
        return;
    }

    let isLikelyBot = false;
    let botName: string | undefined;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.evaluate(user, userItems)) {
            isLikelyBot = true;
            botName = evaluator.name;
            break;
        }
    }

    if (!isLikelyBot) {
        console.log(`Bot check: ${username} doesn't match any bot styles.`);
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.evaluationDisabled) {
        return;
    }

    const isMod = await isModerator(user.username, context);
    if (isMod) {
        console.log(`Bot check: User ${user.username} is a moderator, so not reporting as a bot.`);
        return;
    }

    const currentUser = await context.reddit.getCurrentUser();

    const target = await getPostOrCommentById(thingId, context);
    const reportContext = `Automatically reported via a [${isLinkId(target.id) ? "post" : "comment"}](${target.permalink}) on /r/${target.subredditName}`;
    await addExternalSubmission({
        username: user.username,
        submitter: currentUser?.username,
        reportContext,
    }, context);

    console.log(`Created external submission via automated evaluation for ${user.username} for bot style ${botName}`);

    if (settings[AppSetting.RemoveContentWhenReporting]) {
        if (!target.spam) {
            await context.redis.set(`removed:${target.authorName}`, target.id, { expiration: addWeeks(new Date(), 4) });
        }
        await target.remove();
    }
}

async function checkForBotMentions (event: CommentCreate, context: TriggerContext) {
    if (!event.comment) {
        return;
    }

    const botRegex = [
        /\bbots?\b/i,
        /\bChatGPT\b/i,
        /\bLLM\b/i,
    ];

    const commentBody = event.comment.body;
    const parentId = event.comment.parentId;

    if (!botRegex.some(regex => regex.test(commentBody))) {
        return;
    }

    const parentItem = await getPostOrCommentById(parentId, context);

    await context.redis.set(`botmention:${parentItem.id}`, parentItem.authorName, { expiration: addMinutes(new Date(), 1) });
    console.log(`Bot mention: https://www.reddit.com${event.comment.permalink}`);
}
