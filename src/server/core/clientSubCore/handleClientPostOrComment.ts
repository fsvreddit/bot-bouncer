import { Comment, context, Post, reddit, redis, settings, UserSocialLink } from "@devvit/web/server";
import { isT3, JsonValue, OnCommentCreateRequest, OnCommentUpdateRequest, OnPostCreateRequest, OnPostUpdateRequest, T1, T3 } from "@devvit/web/shared";
import { fixCommentTriggerEvent, fixPostTriggerEvent, getPostOrCommentById, getUserExtended, getUserOrUndefined, isBanned, isContributor } from "@fsvreddit/fsv-devvit-web-helpers";
import { ActionType, addExternalSubmissionFromExternal, addUserToModqueueRemovalStore, ALL_RELEVANT_EVALUTORS, AppSetting, CONFIGURATION_DEFAULTS, CONTROL_SUBREDDIT, expireKeyAt, getControlSubSettings, getUserStatus, isModeratorWithCache, isUserWhitelisted, recordBan, recordBanForSummary, recordUserContentCreation, UserDetails } from "..";
import { getEvaluatorVariables } from "../userEvaluation";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { addDays, formatDate } from "date-fns";

export async function handleClientPostCreate (event: OnPostCreateRequest) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleClientPostCreate should not be called for the control subreddit, check the subreddit name handling logic");
    }

    if (await settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    event = await fixPostTriggerEvent(event);

    if (!event.post || !event.author?.name) {
        console.error("Content Create: PostCreate event missing post or author information", JSON.stringify(event));
        return;
    }

    console.log(`Content Create: PostCreate ${event.post.id} by ${event.author.name}`);

    await recordUserContentCreation(event.author.name);

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(event.author.name);
    if (currentStatus) {
        await handleContentCreation(event.author.name, currentStatus, event.post.id as T3);
        return;
    }

    const variables = await getEvaluatorVariables();

    const post = await reddit.getPostById(event.post.id as T3);
    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator([], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (await Promise.resolve(evaluator.preEvaluatePost(post))) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, post, variables);
    }
}

export async function handleClientCommentCreate (event: OnCommentCreateRequest) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleClientCommentCreate should not be called for the control subreddit, check the subreddit name handling logic");
    }

    if (await settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    const fixedEvent = await fixCommentTriggerEvent(event);

    if (!fixedEvent.comment || !fixedEvent.author?.name) {
        return;
    }

    await recordUserContentCreation(fixedEvent.author.name);

    if (fixedEvent.author.name === "AutoModerator" || fixedEvent.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(fixedEvent.author.name);
    if (currentStatus) {
        await handleContentCreation(fixedEvent.author.name, currentStatus, fixedEvent.comment.id as T1);
        return;
    }

    const variables = await getEvaluatorVariables();

    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator([], undefined, variables);
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

    await checkAndReportPotentialBot(fixedEvent.author.name, fixedEvent, variables);
}

export async function handleClientCommentUpdate (event: OnCommentUpdateRequest) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (await settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    const fixedEvent = await fixCommentTriggerEvent(event);

    if (!fixedEvent.comment || !fixedEvent.author?.name) {
        return;
    }

    if (fixedEvent.author.name === "AutoModerator" || fixedEvent.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(fixedEvent.author.name);
    if (currentStatus) {
        return;
    }

    const variables = await getEvaluatorVariables();

    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator([], undefined, variables);
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

    await checkAndReportPotentialBot(fixedEvent.author.name, fixedEvent, variables);
}

export async function handleClientPostUpdate (event: OnPostUpdateRequest) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (await settings.get<boolean>(AppSetting.DisableClientChecks)) {
        return;
    }

    event = await fixPostTriggerEvent(event);

    if (!event.post || !event.author?.name) {
        console.error("Content Update: PostUpdate event missing post or author information", JSON.stringify(event));
        return;
    }

    console.log(`Content Create: PostUpdate ${event.post.id} by ${event.author.name}`);

    if (event.author.name === "AutoModerator" || event.author.name === `${context.subredditName}-ModTeam`) {
        return;
    }

    const currentStatus = await getUserStatus(event.author.name);
    if (currentStatus) {
        return;
    }

    const variables = await getEvaluatorVariables();

    const post = await reddit.getPostById(event.post.id as T3);
    let possibleBot = false;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator([], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (await Promise.resolve(evaluator.preEvaluatePost(post))) {
            possibleBot = true;
            break;
        }
    }

    if (possibleBot) {
        await checkAndReportPotentialBot(event.author.name, post, variables);
    }
}

async function handleContentCreation (username: string, currentStatus: UserDetails, targetId: T1 | T3) {
    console.log(`Content Create: ℹ️ User ${username} has status ${currentStatus.userStatus}.`);
    const isBannable = currentStatus.userStatus === UserStatus.Banned || (currentStatus.userStatus === UserStatus.Purged && currentStatus.lastStatus === UserStatus.Banned);
    if (!isBannable) {
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowBans) {
        console.log(`Content Create: ${username} is banned but allowBans is false, so will not be actioned.`);
        return;
    }

    const userWhitelisted = await isUserWhitelisted(username);
    if (userWhitelisted) {
        console.log(`Content Create: ${username} is allowlisted after a previous unban, so will not be actioned.`);
        return;
    }

    console.log(`Content Create: Status for ${username} is marked as ${currentStatus.userStatus}`);

    const subredditName = context.subredditName;

    const user = await getUserOrUndefined(username);

    if (!user) {
        console.log(`Content Create: ${username} appears to be shadowbanned.`);
        return;
    }

    const flair = await user.getUserFlairBySubreddit(subredditName);
    if (flair?.flairCssClass?.toLowerCase().endsWith("proof")) {
        console.log(`Content Create: ${user.username} is allowlisted via flair`);
        return;
    }

    const appSettings = await settings.getAll();

    const exemptApprovedUsers = appSettings[AppSetting.ExemptApprovedUsers] as boolean | undefined ?? true;
    if (exemptApprovedUsers && await isContributor(subredditName, user.username)) {
        console.log(`Content Create: ${user.username} is allowlisted as an approved user`);
        return;
    }

    if (await isModeratorWithCache(user.username)) {
        console.log(`Content Create: ${user.username} is allowlisted as a moderator`);
        return;
    }

    const [actionToTake] = appSettings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];

    const promises: Promise<unknown>[] = [];
    const target = await getPostOrCommentById(targetId);

    if (actionToTake === ActionType.Ban) {
        const isCurrentlyBanned = await isBanned(subredditName, user.username);

        if (!isCurrentlyBanned) {
            let message = appSettings[AppSetting.BanMessage] as string | undefined ?? CONFIGURATION_DEFAULTS.banMessage;
            message = message.replaceAll("{subreddit}", subredditName)
                .replaceAll("{account}", user.username)
                .replaceAll("{link}", user.username);

            const banNote = CONFIGURATION_DEFAULTS.banNote
                .replaceAll("{me}", context.appSlug)
                .replaceAll("{date}", formatDate(new Date(), "yyyy-MM-dd"));

            promises.push(reddit.banUser({
                subredditName,
                username: user.username,
                message,
                note: banNote,
            }));

            promises.push(recordBan(username));
            promises.push(recordBanForSummary(username));
            console.log(`Content Create: 💥 ${user.username} banned from ${subredditName}`);
        }

        const removedByMod = await redis.get(`removedbymod:${targetId}`);
        if (!removedByMod || removedByMod === "AutoModerator" || removedByMod === "reddit") {
            promises.push(reddit.remove(targetId, false));
            if (appSettings[AppSetting.LockContentWhenRemoving]) {
                const target = await getPostOrCommentById(targetId);
                if (!target.locked) {
                    promises.push(target.lock());
                    await redis.hSet(`lockedItems:${username}`, { [targetId]: targetId });
                    promises.push(expireKeyAt(`lockedItems:${username}`, addDays(new Date(), 14)));
                }
            }
            console.log(`Content Create: ${targetId} removed for ${user.username}`);
        }

        if (appSettings[AppSetting.RemoveFromModqueueWhenBanning]) {
            await addUserToModqueueRemovalStore(username);
        }
    } else if (actionToTake === ActionType.Filter) {
        promises.push(reddit.filter(targetId, { keep: false, reason: "User is listed as a bot on r/BotBouncer" }));
        console.log(`Content Create: ${targetId} filtered for ${user.username}`);
    } else { // Report
        promises.push(reddit.report(target, { reason: "User is listed as a bot on /r/BotBouncer" }));
        console.log(`Content Create: ${targetId} reported for ${user.username}`);
    }

    await Promise.allSettled(promises);
}

async function checkAndReportPotentialBot (username: string, target: Post | OnCommentCreateRequest | OnCommentUpdateRequest, variables: Record<string, JsonValue>) {
    const user = await getUserExtended(username);
    if (!user) {
        return;
    }

    const targetId = "id" in target ? target.id : target.comment?.id;
    if (!targetId) {
        return;
    }

    let userItems: (Post | Comment)[] | undefined;
    let isLikelyBot = false;
    let anyEvaluatorsChecked = false;
    let botName: string | undefined;

    let socialLinks: UserSocialLink[] | undefined;

    const openAIEvaluationKey = await settings.get<string>(AppSetting.OpenAIEvaluationKey);

    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator([], socialLinks, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (evaluator.needsOpenAiKey && openAIEvaluationKey) {
            evaluator.setOpenAiKey(openAIEvaluationKey);
        }

        if ("id" in target) {
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
                userItems = await reddit.getCommentsAndPostsByUser({
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
            userItems.unshift(await getPostOrCommentById(targetId as T1 | T3));
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
        console.log(`Bot check: ${username} doesn't match any bot styles, checked ${userItems?.length} items.`);
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (controlSubSettings.evaluationDisabled) {
        return;
    }

    const isMod = await isModeratorWithCache(user.username);
    if (isMod) {
        console.log(`Bot check: User ${user.username} is a moderator, so not reporting as a bot.`);
        return;
    }

    const currentUser = await reddit.getCurrentUser();

    const targetItem = await getPostOrCommentById(targetId as T1 | T3);
    const reportContext = `Automatically reported via a [${isT3(targetItem.id) ? "post" : "comment"}](${targetItem.permalink}) on /r/${targetItem.subredditName}`;

    await addExternalSubmissionFromExternal({
        username: user.username,
        subreddit: context.subredditName,
        submitter: currentUser?.username,
        reportContext,
        immediate: true,
        targetId: targetItem.id,
    });

    console.log(`Created external submission via automated evaluation for ${user.username} for bot style ${botName}`);
}
