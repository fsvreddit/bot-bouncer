import { Post, Comment, TriggerContext, SettingsValues, JSONValue } from "@devvit/public-api";
import { CommentCreate, CommentUpdate, PostCreate } from "@devvit/protos";
import { ALL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";
import { addDays, addWeeks, formatDate, subMinutes } from "date-fns";
import { getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { isUserWhitelisted, recordBan } from "./handleClientSubredditWikiUpdate.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getPostOrCommentById, getUserOrUndefined, isApproved, isBanned, isModerator, replaceAll } from "./utility.js";
import { ActionType, AppSetting, CONFIGURATION_DEFAULTS, getControlSubSettings } from "./settings.js";
import { addExternalSubmissionFromClientSub } from "./externalSubmissions.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { recordBanForDigest, recordReportForDigest } from "./modmail/dailyDigest.js";
import { getUserExtended } from "./extendedDevvit.js";

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

    const settings = await context.settings.getAll();

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        await handleContentCreation(event.author.name, currentStatus, event.post.id, context);
        return;
    }

    if (!settings[AppSetting.ReportPotentialBots]) {
        return;
    }

    const variables = await getEvaluatorVariables(context);

    const post = await context.reddit.getPostById(event.post.id);
    let possibleBot = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (evaluator.preEvaluatePost(post)) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, post, settings, variables, context);
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

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        await handleContentCreation(event.author.name, currentStatus, event.comment.id, context);
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
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (evaluator.preEvaluateComment(event)) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
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

    await checkAndReportPotentialBot(event.author.name, event, settings, variables, context);

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

export async function handleClientCommentUpdate (event: CommentUpdate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.comment || !event.author?.name) {
        return;
    }

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

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
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (evaluator.preEvaluateCommentEdit(event)) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
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

    await checkAndReportPotentialBot(event.author.name, event, settings, variables, context);

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

async function handleContentCreation (username: string, currentStatus: UserDetails, targetId: string, context: TriggerContext) {
    if (currentStatus.userStatus !== UserStatus.Banned) {
        return;
    }

    const userWhitelisted = await isUserWhitelisted(username, context);
    if (userWhitelisted) {
        console.log(`${username} is allowlisted after a previous unban, so will not be actioned.`);
        return;
    }

    console.log(`Content Create: Status for ${username} is banned`);

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const user = await getUserOrUndefined(username, context);

    if (!user) {
        console.log(`Content Create: ${username} appears to be shadowbanned.`);
        return;
    }

    const flair = await user.getUserFlairBySubreddit(subredditName);
    if (flair?.flairCssClass?.toLowerCase().endsWith("proof")) {
        console.log(`Content Create: ${user.username} is allowlisted via flair`);
        return;
    }

    if (await isApproved(user.username, context)) {
        console.log(`Content Create: ${user.username} is allowlisted as an approved user`);
        return;
    }

    if (await isModerator(user.username, context)) {
        console.log(`Content Create: ${user.username} is allowlisted as a moderator`);
        return;
    }

    const settings = await context.settings.getAll();
    const [actionToTake] = settings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];

    const promises: Promise<unknown>[] = [];
    const target = await getPostOrCommentById(targetId, context);

    if (actionToTake === ActionType.Ban) {
        const removedByMod = await context.redis.exists(`removedbymod:${targetId}`);
        if (!removedByMod && !target.spam && !target.removed) {
            promises.push(context.reddit.remove(targetId, true));
            console.log(`Content Create: ${targetId} removed for ${user.username}`);
            promises.push(context.redis.set(`removed:${username}`, targetId, { expiration: addWeeks(new Date(), 2) }));
        } else {
            // Might be in the modqueue.
            const modQueue = await context.reddit.getModQueue({
                subreddit: subredditName,
                type: "all",
            }).all();
            const foundInModQueue = modQueue.find(item => item.id === targetId);
            if (foundInModQueue) {
                promises.push(context.reddit.remove(foundInModQueue.id, true));
                console.log(`Content Create: ${foundInModQueue.id} removed via mod queue for ${user.username}`);
            }
        }

        const isCurrentlyBanned = await isBanned(user.username, context);

        if (!isCurrentlyBanned) {
            let message = await context.settings.get<string>(AppSetting.BanMessage) ?? CONFIGURATION_DEFAULTS.banMessage;
            message = replaceAll(message, "{subreddit}", subredditName);
            message = replaceAll(message, "{account}", user.username);
            message = replaceAll(message, "{link}", user.username);

            let banNote = CONFIGURATION_DEFAULTS.banNote;
            banNote = replaceAll(banNote, "{me}", context.appName);
            banNote = replaceAll(banNote, "{date}", formatDate(new Date(), "yyyy-MM-dd"));

            promises.push(context.reddit.banUser({
                subredditName,
                username: user.username,
                message,
                note: banNote,
            }));

            promises.push(recordBan(username, context.redis));
            promises.push(recordBanForDigest(username, context.redis));
            console.log(`Content Create: ${user.username} banned from ${subredditName}`);
        }
    } else {
        // Report, not ban.
        promises.push(context.reddit.report(target, { reason: "User is listed as a bot on /r/BotBouncer" }));
    }

    await Promise.all(promises);
}

async function checkAndReportPotentialBot (username: string, target: Post | CommentCreate, settings: SettingsValues, variables: Record<string, JSONValue>, context: TriggerContext) {
    const user = await getUserExtended(username, context);
    if (!user) {
        return;
    }

    const targetId = target instanceof Post ? target.id : target.comment?.id;
    if (!targetId) {
        return;
    }

    let userItems: (Post | Comment)[] | undefined;
    let isLikelyBot = false;
    let anyEvaluatorsChecked = false;
    let botName: string | undefined;

    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (target instanceof Post) {
            if (!evaluator.preEvaluatePost(target)) {
                continue;
            }
        } else {
            if (!evaluator.preEvaluateComment(target)) {
                continue;
            }
        }

        const userEvalateResult = await Promise.resolve(evaluator.preEvaluateUser(user));
        if (!userEvalateResult) {
            continue;
        }

        // Get user's history if it hasn't been fetched yet.
        if (userItems === undefined) {
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
        }

        anyEvaluatorsChecked = true;
        const evaluationResult = await Promise.resolve(evaluator.evaluate(user, userItems));
        if (evaluationResult) {
            isLikelyBot = true;
            botName = evaluator.name;
            break;
        }
    }

    if (!anyEvaluatorsChecked) {
        // No evaluators passed user pre-evaluation.
        return;
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

    const targetItem = await getPostOrCommentById(targetId, context);
    const reportContext = `Automatically reported via a [${isLinkId(targetItem.id) ? "post" : "comment"}](${targetItem.permalink}) on /r/${targetItem.subredditName}`;
    const promises: Promise<unknown>[] = [];

    promises.push(
        addExternalSubmissionFromClientSub({
            username: user.username,
            submitter: currentUser?.username,
            reportContext,
        }, "automatic", context),
        recordReportForDigest(user.username, "automatically", context.redis),
    );

    console.log(`Created external submission via automated evaluation for ${user.username} for bot style ${botName}`);

    const [actionToTake] = settings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];
    if (actionToTake === ActionType.Ban && settings[AppSetting.RemoveContentWhenReporting]) {
        const removedByMod = await context.redis.exists(`removedbymod:${targetItem.id}`);
        if (!removedByMod && !targetItem.spam) {
            promises.push(
                context.redis.set(`removed:${targetItem.authorName}`, targetItem.id, { expiration: addWeeks(new Date(), 2) }),
                targetItem.remove(),
            );
        }
    } else if (actionToTake === ActionType.Report) {
        promises.push(context.redis.set(`reported:${targetItem.id}`, "true", { expiration: addWeeks(new Date(), 2) }));
    }

    await Promise.all(promises);
}
