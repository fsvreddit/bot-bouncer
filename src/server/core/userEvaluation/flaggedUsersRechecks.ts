import { context, reddit, redis, scheduler, settings, TaskRequest, UserSocialLink } from "@devvit/web/server";
import { getUserExtended, hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { EvaluateBioTextDefinedHandles, EvaluateBotGroupAdvanced, EvaluateBotGroupAdvancedInternal, EvaluatePostTitleDefinedHandles, EvaluateSocialLinks } from "@fsvreddit/bot-bouncer-evaluation";
import { addMinutes, addSeconds } from "date-fns";
import { AppSetting, ControlSubredditJob, getControlSubSettings, getUserStatus, UserFlag } from "..";
import pluralize from "pluralize";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { getEvaluatorVariables } from "./evaluatorVariables";
import json2md from "json2md";
import { FlaggedRechecksQueueJobData } from "../../tasks";
import { getSummaryForUser } from "../controlSubCore/userSummary";
import { markdownToText } from "../controlSubCore/modmail";

const FLAGGED_RECHECKS_QUEUE_KEY = "flaggedRechecksQueue";

export async function addUserToFlaggedRechecksQueue (username: string): Promise<void> {
    await redis.zAdd(FLAGGED_RECHECKS_QUEUE_KEY, { member: username, score: Date.now() });
}

export async function checkUserFlaggedRechecksQueue (event: TaskRequest<FlaggedRechecksQueueJobData>): Promise<void> {
    const jobGuid = event.data.jobGuid;
    if (await hasTriggerBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`FlaggedRechecks: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const inProgressKey = "flaggedRechecksInProgress";
    if (event.data.firstRun && await redis.exists(inProgressKey)) {
        console.log("FlaggedRechecks: Job already in progress on first run, skipping execution to avoid duplicate jobs");
        return;
    }

    const queue = await redis.zRange(FLAGGED_RECHECKS_QUEUE_KEY, 0, Date.now(), { by: "score" });
    if (queue.length === 0) {
        console.log("FlaggedRechecks: No users in flagged rechecks queue");
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowRechecks) {
        console.log("FlaggedRechecks: Rechecks are disabled in the control subreddit settings, clearing queue");
        await redis.del(FLAGGED_RECHECKS_QUEUE_KEY);
        return;
    }

    if (event.data.firstRun) {
        console.log(`FlaggedRechecks: Found ${queue.length} ${pluralize("user", queue.length)} in flagged rechecks queue on first run, starting to process`);
    }

    const username = queue.shift()?.member;
    if (!username) {
        await redis.del(inProgressKey);
        return;
    }

    await redis.set(inProgressKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    try {
        await recheckFlaggedUser(username);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`FlaggedRechecks: Error rechecking flagged user ${username}: ${errorMessage}`);
    }

    await redis.zRem(FLAGGED_RECHECKS_QUEUE_KEY, [username]);

    if (queue.length > 0) {
        await scheduler.runJob<FlaggedRechecksQueueJobData>({
            name: ControlSubredditJob.FlaggedUsersRechecks,
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        console.log("FlaggedRechecks: Queue is empty, clearing in progress key");
        await redis.del(inProgressKey);
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
export async function recheckFlaggedUser (username: string): Promise<void> {
    const currentStatus = await getUserStatus(username);
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

    const user = await getUserExtended(username);
    if (!user) {
        console.error("FlaggedRechecks: Could not fetch user details for", username);
        return;
    }

    const userHistory = await reddit.getCommentsAndPostsByUser({
        username,
        limit: 100,
        sort: "new",
    }).all();

    const variables = await getEvaluatorVariables();
    let matchesEvaluator = false;
    let userSocialLinks: UserSocialLink[] | undefined;

    const openAIEvaluationKey = await settings.get<string>(AppSetting.OpenAIEvaluationKey);

    for (const Evaluator of FLAGGED_USER_RECHECKS_EVALUATORS) {
        const evaluator = new Evaluator(userHistory, userSocialLinks, variables);

        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (evaluator.needsOpenAiKey && openAIEvaluationKey) {
            evaluator.setOpenAiKey(openAIEvaluationKey);
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

    message.push(...await getSummaryForUser(user.username, "modmail"));

    const modmailStrings = markdownToText(message);

    const firstString = modmailStrings.shift();
    if (!firstString) {
        console.error("FlaggedRechecks: No content to send in modmail for user", user.username);
        return;
    }

    const newConversationId = await reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: `Flagged User Recheck: ${user.username}`,
        bodyMarkdown: firstString,
    });

    for (const string of modmailStrings) {
        await reddit.modMail.reply({
            body: string,
            conversationId: newConversationId,
            isInternal: true,
        });
    }
    return;
}
