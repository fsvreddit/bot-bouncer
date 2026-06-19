import { JobContext, JSONObject, ScheduledJobEvent, UserSocialLink } from "@devvit/public-api";
import { EvaluateBioTextDefinedHandles, EvaluateBotGroupAdvanced, EvaluateBotGroupAdvancedInternal, EvaluatePostTitleDefinedHandles, EvaluateSocialLinks } from "@fsvreddit/bot-bouncer-evaluation";
import { getUserStatus, UserFlag, UserStatus } from "../dataStore.js";
import { getEvaluatorVariables } from "./evaluatorVariables.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import json2md from "json2md";
import { markdownToText } from "../modmail/controlSubModmail.js";
import { addMinutes, addSeconds } from "date-fns";
import { ControlSubredditJob } from "../constants.js";
import pluralize from "pluralize";
import { getUserExtended } from "@fsvreddit/fsv-devvit-helpers";

const FLAGGED_RECHECKS_QUEUE_KEY = "flaggedRechecksQueue";

export async function addUserToFlaggedRechecksQueue (username: string, context: JobContext): Promise<void> {
    await context.redis.zAdd(FLAGGED_RECHECKS_QUEUE_KEY, { member: username, score: Date.now() });
}

export async function checkUserFlaggedRechecksQueue (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext): Promise<void> {
    const inProgressKey = "flaggedRechecksInProgress";
    if (event.data?.firstRun && await context.redis.exists(inProgressKey)) {
        console.log("FlaggedRechecks: Job already in progress on first run, skipping execution to avoid duplicate jobs");
        return;
    }

    const queue = await context.redis.zRange(FLAGGED_RECHECKS_QUEUE_KEY, 0, Date.now(), { by: "score" });
    if (queue.length === 0) {
        console.log("FlaggedRechecks: No users in flagged rechecks queue");
        return;
    }

    if (event.data?.firstRun) {
        console.log(`FlaggedRechecks: Found ${queue.length} ${pluralize("user", queue.length)} in flagged rechecks queue on first run, starting to process`);
    }

    const username = queue.shift()?.member;
    if (!username) {
        await context.redis.del(inProgressKey);
        return;
    }

    await context.redis.set(inProgressKey, Date.now.toString(), { expiration: addMinutes(new Date(), 1) });

    try {
        await recheckFlaggedUser(username, context);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`FlaggedRechecks: Error rechecking flagged user ${username}: ${errorMessage}`);
    }

    await context.redis.zRem(FLAGGED_RECHECKS_QUEUE_KEY, [username]);

    if (queue.length > 0) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.FlaggedUsersRechecks,
            data: { firstRun: false },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        console.log("FlaggedRechecks: Queue is empty, clearing in progress key");
        await context.redis.del(inProgressKey);
    }
}

const FLAGGED_USER_RECHECKS_EVALUATORS = [
    // Synchronous evaluators
    EvaluateBioTextDefinedHandles,
    EvaluatePostTitleDefinedHandles,

    // Evaluators that may need asynchronous calls
    EvaluateBotGroupAdvanced,
    EvaluateBotGroupAdvancedInternal,
    EvaluateSocialLinks,
];

/**
 * Rechecks users flagged as "Hacked and Recovered", "Scammed", or "Future NSFW" to see if they now match Bot Group Advanced evaluation
 * @param username The username of the user to check
 * @param currentStatus Their current user status
 * @param context Reddit's context
 */
export async function recheckFlaggedUser (username: string, context: JobContext): Promise<void> {
    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus) {
        return;
    }

    const eligibleFlags = [UserFlag.HackedAndRecovered, UserFlag.Scammed, UserFlag.FutureNSFW];

    if (!currentStatus.flags) {
        return;
    }

    if (!currentStatus.flags.some(flag => eligibleFlags.includes(flag))) {
        return;
    }

    if (currentStatus.userStatus !== UserStatus.Organic) {
        return;
    }

    const user = await getUserExtended(username, context);
    if (!user) {
        console.error("FlaggedRechecks: Could not fetch user details for", username);
        return;
    }

    const userHistory = await context.reddit.getCommentsAndPostsByUser({
        username,
        limit: 100,
        sort: "new",
    }).all();

    const variables = await getEvaluatorVariables(context);
    let matchesEvaluator = false;
    let userSocialLinks: UserSocialLink[] | undefined;

    for (const Evaluator of FLAGGED_USER_RECHECKS_EVALUATORS) {
        const evaluator = new Evaluator(context, userHistory, userSocialLinks, variables);

        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (!await Promise.resolve(evaluator.preEvaluateUser(user))) {
            userSocialLinks ??= evaluator.socialLinks;
            continue;
        }

        if (await Promise.resolve(evaluator.evaluate(user))) {
            matchesEvaluator = true;
            break;
        }

        userSocialLinks ??= evaluator.socialLinks;
    }

    if (!matchesEvaluator) {
        console.log(`FlaggedRechecks: User ${user.username} does not match any evaluators`);
        return;
    }

    const message: json2md.DataObject[] = [
        { p: `User ${user.username} has flags ${currentStatus.flags.join(", ")} and is marked as organic, but currently matches evaluators. Check to see if action is needed` },
        { hr: "" },
    ];

    message.push(...await getSummaryForUser(user.username, "modmail", context));

    const modmailStrings = markdownToText(message);

    const firstString = modmailStrings.shift();
    if (!firstString) {
        console.error("FlaggedRechecks: No content to send in modmail for user", user.username);
        return;
    }

    const newConversationId = await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: `Flagged User Recheck: ${user.username}`,
        bodyMarkdown: firstString,
    });

    for (const string of modmailStrings) {
        await context.reddit.modMail.reply({
            body: string,
            conversationId: newConversationId,
            isInternal: true,
        });
    }
    return;
}
