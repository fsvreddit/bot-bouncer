import { Post, Comment, TriggerContext, JSONValue, UserSocialLink } from "@devvit/public-api";
import { CommentCreate, CommentUpdate, PostCreate, PostUpdate } from "@devvit/protos";
import { addDays, addSeconds, formatDate, subMinutes } from "date-fns";
import { getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { addUserToModqueueRemovalStore, isUserWhitelisted, recordBan, recordUserContentCreation } from "./handleClientSubredditClassificationChanges.js";
import { ALL_RELEVANT_EVALUTORS, CONTROL_SUBREDDIT } from "./constants.js";
import { getUserOrUndefined, isModeratorWithCache } from "./utility.js";
import { ActionType, AppSetting, CONFIGURATION_DEFAULTS, getControlSubSettings } from "./settings.js";
import { addExternalSubmissionFromClientSub } from "./externalSubmissions.js";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { recordBanForSummary } from "./modmail/actionSummary.js";
import { expireKeyAt, isBanned, isContributor } from "devvit-helpers";
import { filterContent, fixCommentTriggerEvent, fixPostTriggerEvent, getPostOrCommentById, getUserExtended, hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

export async function handleClientPostCreate (event: PostCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleClientPostCreate should not be called for the control subreddit, check the subreddit name handling logic");
    }

    if (await context.settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    event = await fixPostTriggerEvent(event, context);

    if (!event.post || !event.author?.name) {
        console.error("Content Create: PostCreate event missing post or author information", JSON.stringify(event));
        return;
    }

    console.log(`Content Create: PostCreate ${event.post.id} by ${event.author.name}`);

    await recordUserContentCreation(event.author.name, context);

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        await handleContentCreation(event.author.name, currentStatus, event.post.id, context);
        return;
    }

    const variables = await getEvaluatorVariables(context);

    const post = await context.reddit.getPostById(event.post.id);
    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, [], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (await Promise.resolve(evaluator.preEvaluatePost(post))) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, post, variables, context);
    }
}

export async function handleClientCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleClientCommentCreate should not be called for the control subreddit, check the subreddit name handling logic");
    }

    if (await context.settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    const fixedEvent = await fixCommentTriggerEvent(event, context);

    if (!fixedEvent.comment || !fixedEvent.author?.name) {
        return;
    }

    await recordUserContentCreation(fixedEvent.author.name, context);

    if (fixedEvent.author.name === "AutoModerator" || fixedEvent.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(fixedEvent.author.name, context);
    if (currentStatus) {
        await handleContentCreation(fixedEvent.author.name, currentStatus, fixedEvent.comment.id, context);
        return;
    }

    const variables = await getEvaluatorVariables(context);

    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, [], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (await Promise.resolve(evaluator.preEvaluateComment(fixedEvent))) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
        return;
    }

    const redisKey = `lastBotCheckForUser:${fixedEvent.author.name}`;
    const recentlyChecked = await context.redis.get(redisKey);
    if (recentlyChecked) {
        // Allow some rechecks within 15 minutes, to find rapid fire bots.
        const lastCheck = new Date(parseInt(recentlyChecked));
        if (lastCheck < subMinutes(new Date(), 15)) {
            return;
        }
    }

    await checkAndReportPotentialBot(fixedEvent.author.name, fixedEvent, variables, context);

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

export async function handleClientCommentUpdate (event: CommentUpdate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (await context.settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    const fixedEvent = await fixCommentTriggerEvent(event, context);

    if (!fixedEvent.comment || !fixedEvent.author?.name) {
        return;
    }

    if (await hasTriggerBeenHandled(context.redis, `CommentUpdate:${fixedEvent.comment.id}`, { expiration: addSeconds(new Date(), 10) })) {
        return;
    }

    if (fixedEvent.author.name === "AutoModerator" || fixedEvent.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(fixedEvent.author.name, context);
    if (currentStatus) {
        return;
    }

    const variables = await getEvaluatorVariables(context);

    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, [], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (await Promise.resolve(evaluator.preEvaluateCommentEdit(fixedEvent))) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
        return;
    }

    const redisKey = `lastBotCheckForUser:${fixedEvent.author.name}`;
    const recentlyChecked = await context.redis.get(redisKey);
    if (recentlyChecked) {
        // Allow some rechecks within 15 minutes, to find rapid fire bots.
        const lastCheck = new Date(parseInt(recentlyChecked));
        if (lastCheck < subMinutes(new Date(), 15)) {
            return;
        }
    }

    await checkAndReportPotentialBot(fixedEvent.author.name, fixedEvent, variables, context);

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

export async function handleClientPostUpdate (event: PostUpdate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (await context.settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    event = await fixPostTriggerEvent(event, context);

    if (!event.post || !event.author?.name) {
        console.error("Content Update: PostUpdate event missing post or author information", JSON.stringify(event));
        return;
    }

    console.log(`Content Create: PostUpdate ${event.post.id} by ${event.author.name}`);

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(event.author.name, context);
    if (currentStatus) {
        return;
    }

    const variables = await getEvaluatorVariables(context);

    const post = await context.reddit.getPostById(event.post.id);
    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, [], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (await Promise.resolve(evaluator.preEvaluatePost(post))) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, post, variables, context);
    }
}

async function handleContentCreation (username: string, currentStatus: UserDetails, targetId: string, context: TriggerContext) {
    console.log(`Content Create: ℹ️ User ${username} has status ${currentStatus.userStatus}.`);
    const isBannable = currentStatus.userStatus === UserStatus.Banned || (currentStatus.userStatus === UserStatus.Purged && currentStatus.lastStatus === UserStatus.Banned);
    if (!isBannable) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.allowBans) {
        console.log(`Content Create: ${username} is banned but allowBans is false, so will not be actioned.`);
        return;
    }

    const userWhitelisted = await isUserWhitelisted(username, context);
    if (userWhitelisted) {
        console.log(`Content Create: ${username} is allowlisted after a previous unban, so will not be actioned.`);
        return;
    }

    console.log(`Content Create: Status for ${username} is marked as ${currentStatus.userStatus}`);

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

    const settings = await context.settings.getAll();

    const exemptApprovedUsers = settings[AppSetting.ExemptApprovedUsers] as boolean | undefined ?? true;
    if (exemptApprovedUsers && await isContributor(context.reddit, subredditName, user.username)) {
        console.log(`Content Create: ${user.username} is allowlisted as an approved user`);
        return;
    }

    if (await isModeratorWithCache(user.username, context)) {
        console.log(`Content Create: ${user.username} is allowlisted as a moderator`);
        return;
    }

    const [actionToTake] = settings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];

    const promises: Promise<unknown>[] = [];
    const target = await getPostOrCommentById(context.reddit, targetId);

    if (actionToTake === ActionType.Ban) {
        const isCurrentlyBanned = await isBanned(context.reddit, subredditName, user.username);

        if (!isCurrentlyBanned) {
            let message = settings[AppSetting.BanMessage] as string | undefined ?? CONFIGURATION_DEFAULTS.banMessage;
            message = message.replaceAll("{subreddit}", subredditName)
                .replaceAll("{account}", user.username)
                .replaceAll("{link}", user.username);

            const banNote = CONFIGURATION_DEFAULTS.banNote
                .replaceAll("{me}", context.appSlug)
                .replaceAll("{date}", formatDate(new Date(), "yyyy-MM-dd"));

            promises.push(context.reddit.banUser({
                subredditName,
                username: user.username,
                message,
                note: banNote,
            }));

            promises.push(recordBan(username, context.redis));
            promises.push(recordBanForSummary(username, context.redis));
            console.log(`Content Create: 💥 ${user.username} banned from ${subredditName}`);
        }

        const removedByMod = await context.redis.exists(`removedbymod:${targetId}`);
        if (!removedByMod) {
            promises.push(context.reddit.remove(targetId, true));
            if (settings[AppSetting.LockContentWhenRemoving]) {
                const target = await getPostOrCommentById(context.reddit, targetId);
                if (!target.locked) {
                    promises.push(target.lock());
                    await context.redis.hSet(`lockedItems:${username}`, { [targetId]: targetId });
                    promises.push(expireKeyAt(context.redis, `lockedItems:${username}`, addDays(new Date(), 14)));
                }
            }
            console.log(`Content Create: ${targetId} removed for ${user.username}`);
        }

        if (settings[AppSetting.RemoveFromModqueueWhenBanning]) {
            await addUserToModqueueRemovalStore(username, context);
        }
    } else if (actionToTake === ActionType.Filter) {
        promises.push(filterContent(context, { itemId: targetId, reason: "User is listed as a bot on r/BotBouncer" }));
        console.log(`Content Create: ${targetId} filtered for ${user.username}`);
    } else { // Report
        promises.push(context.reddit.report(target, { reason: "User is listed as a bot on /r/BotBouncer" }));
        console.log(`Content Create: ${targetId} reported for ${user.username}`);
    }

    await Promise.allSettled(promises);
}

async function checkAndReportPotentialBot (username: string, target: Post | CommentCreate, variables: Record<string, JSONValue>, context: TriggerContext) {
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

    let socialLinks: UserSocialLink[] | undefined;

    const openAIEvaluationKey = await context.settings.get<string>(AppSetting.OpenAIEvaluationKey);

    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, [], socialLinks, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (evaluator.needsOpenAiKey && openAIEvaluationKey) {
            evaluator.setOpenAiKey(openAIEvaluationKey);
        }

        if (target instanceof Post) {
            if (!await Promise.resolve(evaluator.preEvaluatePost(target))) {
                continue;
            }
        } else {
            if (!await Promise.resolve(evaluator.preEvaluateComment(target))) {
                continue;
            }
        }

        const userEvalateResult = await Promise.resolve(evaluator.preEvaluateUser(user));
        if (!socialLinks && evaluator.socialLinks) {
            socialLinks = evaluator.socialLinks;
        }

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

        if (!userItems.some(item => item.id === targetId)) {
            userItems.unshift(await getPostOrCommentById(context.reddit, targetId));
        }

        evaluator.setHistory(userItems);

        anyEvaluatorsChecked = true;
        const evaluationResult = await Promise.resolve(evaluator.evaluate(user));
        if (!socialLinks && evaluator.socialLinks) {
            socialLinks = evaluator.socialLinks;
        }

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

    const isMod = await isModeratorWithCache(user.username, context);
    if (isMod) {
        console.log(`Bot check: User ${user.username} is a moderator, so not reporting as a bot.`);
        return;
    }

    const currentUser = await context.reddit.getCurrentUser();

    const targetItem = await getPostOrCommentById(context.reddit, targetId);
    const reportContext = `Automatically reported via a [${isLinkId(targetItem.id) ? "post" : "comment"}](${targetItem.permalink}) on /r/${targetItem.subredditName}`;

    await addExternalSubmissionFromClientSub({
        username: user.username,
        subreddit: context.subredditName,
        submitter: currentUser?.username,
        reportContext,
        immediate: true,
        targetId: targetItem.id,
    }, context);

    console.log(`Created external submission via automated evaluation for ${user.username} for bot style ${botName}`);
}
