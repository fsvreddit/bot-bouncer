import { Post, Comment, TriggerContext, SettingsValues, JSONValue, UserSocialLink } from "@devvit/public-api";
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
import { filterContent, getPostOrCommentById, getTrueUsername, getUserExtended, hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

interface EditedContentPreEvaluator {
    preEvaluatePost: (post: Post) => boolean | Promise<boolean>;
    preEvaluateComment: (event: CommentCreate | CommentUpdate) => boolean | Promise<boolean>;
    preEvaluatePostEdit?: (post: Post) => boolean | Promise<boolean>;
    preEvaluateCommentEdit?: (event: CommentUpdate) => boolean | Promise<boolean>;
}

interface PotentialBotCheckOptions {
    contentEdited?: boolean;
}

async function preEvaluateEditedPost (evaluator: EditedContentPreEvaluator, post: Post): Promise<boolean> {
    if (await Promise.resolve(evaluator.preEvaluatePost(post))) {
        return true;
    }

    if (typeof evaluator.preEvaluatePostEdit === "function") {
        return await Promise.resolve(evaluator.preEvaluatePostEdit(post));
    }

    return false;
}

async function preEvaluateEditedComment (evaluator: EditedContentPreEvaluator, event: CommentUpdate): Promise<boolean> {
    if (await Promise.resolve(evaluator.preEvaluateComment(event))) {
        return true;
    }

    if (typeof evaluator.preEvaluateCommentEdit === "function") {
        return await Promise.resolve(evaluator.preEvaluateCommentEdit(event));
    }

    return false;
}

export async function handleClientPostCreate (event: PostCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleClientPostCreate should not be called for the control subreddit, check the subreddit name handling logic");
    }

    if (!event.post || !event.author?.name) {
        console.error("Content Create: PostCreate event missing post or author information", JSON.stringify(event));
        return;
    }

    const username = await getTrueUsername(context.reddit, event.author.name, event.post.id);

    console.log(`Content Create: PostCreate ${event.post.id} by ${username}`);

    await recordUserContentCreation(username, context);

    if (username === "AutoModerator" || username === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus) {
        await handleContentCreation(username, currentStatus, event.post.id, context);
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

        if (evaluator.preEvaluatePost(post)) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        const settings = await context.settings.getAll();
        await checkAndReportPotentialBot(username, post, settings, variables, context);
    }
}

export async function handleClientPostUpdate (event: PostUpdate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.post?.id) {
        console.error("Content Edit: PostUpdate event missing post information", JSON.stringify(event));
        return;
    }

    if (await hasTriggerBeenHandled(context.redis, `PostUpdate:${event.post.id}`, { expiration: addSeconds(new Date(), 10) })) {
        return;
    }

    const post = await context.reddit.getPostById(event.post.id);
    const username = event.author?.name
        ? await getTrueUsername(context.reddit, event.author.name, event.post.id)
        : post.authorName;

    console.log(`Content Edit: PostUpdate ${event.post.id} by ${username}`);

    if (username === "AutoModerator" || username === `${context.subredditName}-ModTeam` || username === "[deleted]") {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
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

        if (await preEvaluateEditedPost(evaluator as EditedContentPreEvaluator, post)) {
            possibleBot = true;
            break;
        }
    }

    if (!possibleBot) {
        return;
    }

    const redisKey = `lastBotCheckForUser:${username}`;
    const recentlyChecked = await context.redis.get(redisKey);
    if (recentlyChecked) {
        // Allow some rechecks within 15 minutes, to find rapid fire bots.
        const lastCheck = new Date(parseInt(recentlyChecked));
        if (lastCheck < subMinutes(new Date(), 15)) {
            return;
        }
    }

    const settings = await context.settings.getAll();
    await checkAndReportPotentialBot(username, post, settings, variables, context, { contentEdited: true });

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

/**
 * Fixes CommentCreate or CommentUpdate events where the comment body and author have been redacted due to being removed or filtered
 * @param event A CommentCreate or CommentUpdate event
 * @param context Reddit's TriggerContext
 * @returns A fixed event of the same type with redacted information restored
 */
async function fixedCommentEvent<T extends CommentCreate | CommentUpdate> (event: T, context: TriggerContext): Promise<T> {
    const eventToReturn: T = { ...event };
    if (!eventToReturn.comment?.id || eventToReturn.author?.name !== "[redacted]") {
        return event;
    }

    const comment = await context.reddit.getCommentById(eventToReturn.comment.id);

    eventToReturn.author.name = comment.authorName;
    if (comment.authorId) {
        eventToReturn.comment.author = comment.authorId;
    }
    eventToReturn.comment.body = comment.body;

    console.log(`Bot check: Fixed event for comment ${comment.id} by ${comment.authorName}`);

    return eventToReturn;
}

export async function handleClientCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleClientCommentCreate should not be called for the control subreddit, check the subreddit name handling logic");
    }

    const fixedEvent = await fixedCommentEvent(event, context);

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

    const settings = await context.settings.getAll();
    await checkAndReportPotentialBot(fixedEvent.author.name, fixedEvent, settings, variables, context);

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

export async function handleClientCommentUpdate (event: CommentUpdate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const fixedEvent = await fixedCommentEvent(event, context);

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

        if (await preEvaluateEditedComment(evaluator as EditedContentPreEvaluator, fixedEvent)) {
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

    const settings = await context.settings.getAll();
    await checkAndReportPotentialBot(fixedEvent.author.name, fixedEvent, settings, variables, context, { contentEdited: true });

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 2) });
}

async function handleContentCreation (username: string, currentStatus: UserDetails, targetId: string, context: TriggerContext) {
    console.log(`Content Create: ℹ️ User ${username} has status ${currentStatus.userStatus}.`);
    if (currentStatus.userStatus !== UserStatus.Banned) {
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

    console.log(`Content Create: Status for ${username} is marked as banned`);

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
            let message = await context.settings.get<string>(AppSetting.BanMessage) ?? CONFIGURATION_DEFAULTS.banMessage;
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

async function checkAndReportPotentialBot (username: string, target: Post | CommentCreate | CommentUpdate, settings: SettingsValues, variables: Record<string, JSONValue>, context: TriggerContext, options: PotentialBotCheckOptions = {}) {
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

    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, [], socialLinks, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (target instanceof Post) {
            const shouldEvaluatePost = options.contentEdited
                ? await preEvaluateEditedPost(evaluator as EditedContentPreEvaluator, target)
                : await Promise.resolve(evaluator.preEvaluatePost(target));
            if (!shouldEvaluatePost) {
                continue;
            }
        } else {
            const shouldEvaluateComment = options.contentEdited
                ? await preEvaluateEditedComment(evaluator as EditedContentPreEvaluator, target as CommentUpdate)
                : await Promise.resolve(evaluator.preEvaluateComment(target as CommentCreate));
            if (!shouldEvaluateComment) {
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
