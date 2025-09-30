import { JobContext, JSONObject, JSONValue, Post, ScheduledJobEvent, TriggerContext, ZMember } from "@devvit/public-api";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { compact, uniq } from "lodash";
import { CONTROL_SUBREDDIT, ControlSubredditJob, EVALUATE_KARMA_FARMING_SUBS_CRON } from "./constants.js";
import { getAllKnownUsers, getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { evaluateUserAccount, storeAccountInitialEvaluationResults, userHasContinuousNSFWHistory } from "./handleControlSubAccountEvaluation.js";
import { getControlSubSettings } from "./settings.js";
import { addSeconds, subMinutes, subWeeks } from "date-fns";
import { getUserExtended } from "./extendedDevvit.js";
import { AsyncSubmission, PostCreationQueueResult, queuePostCreation } from "./postCreation.js";
import pluralize from "pluralize";
import json2md from "json2md";
import { CronExpressionParser } from "cron-parser";

export const CHECK_DATE_KEY = "KarmaFarmingSubsCheckDates";

interface AccountsToCheck {
    subredditName: string;
    accounts: string[];
}

async function getAccountsFromSub (subredditName: string, since: Date, context: JobContext): Promise<AccountsToCheck | undefined> {
    let posts: Post[];
    try {
        posts = await context.reddit.getNewPosts({
            subredditName,
            limit: 100,
        }).all();
    } catch (error) {
        console.error(`Karma Farming Subs: Error getting posts from ${subredditName}: ${error}`);
        return;
    }

    return {
        subredditName,
        accounts: uniq(posts.filter(post => post.createdAt > since && post.authorName !== "[deleted]").map(post => post.authorName)),
    };
}

function lastCheckDateForSub (subredditName: string, lastCheckDates: ZMember[]): Date {
    const lastCheckDate = lastCheckDates.find(item => item.member === subredditName);
    return new Date(lastCheckDate?.score ?? 0);
}

interface SubWithDate {
    subredditName: string;
    lastCheckDate: Date;
}

async function getDistinctAccounts (context: JobContext): Promise<string[]> {
    const variables = await getEvaluatorVariables(context);
    const karmaFarmingSubs = variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];
    const karmaFarmingSubsNSFW = variables["generic:karmafarminglinksubsnsfw"] as string[] | undefined ?? [];
    const uniqueSubs = uniq([...karmaFarmingSubs, ...karmaFarmingSubsNSFW]);

    // Remove check dates older than a week.
    await context.redis.zRemRangeByScore(CHECK_DATE_KEY, 0, subWeeks(new Date(), 1).getTime());

    const lastDates = await context.redis.zRange(CHECK_DATE_KEY, 0, -1);

    const subsWithDates: SubWithDate[] = [];
    for (const sub of uniqueSubs) {
        const lastCheckDate = lastCheckDateForSub(sub, lastDates);
        if (lastCheckDate < subMinutes(new Date(), 25)) {
            subsWithDates.push({ subredditName: sub, lastCheckDate });
        }
    }

    // Order subs by oldest first.
    subsWithDates.sort((a, b) => a.lastCheckDate.getTime() - b.lastCheckDate.getTime());

    // Take top 200 subreddits.
    const subsToCheck: Record<string, Date> = {};
    for (const sub of subsWithDates.slice(0, 200)) {
        subsToCheck[sub.subredditName] = sub.lastCheckDate;
    }

    console.log(`Karma Farming Subs: Checking ${Object.keys(subsToCheck).length} distinct subs out of ${Object.keys(subsWithDates).length} subs not checked recently.`);
    const firstDate = subsWithDates.find(entry => entry.lastCheckDate > new Date(0))?.lastCheckDate;
    if (firstDate) {
        console.log(`Karma Farming Subs: First check date is ${firstDate.toISOString()}`);
    }

    console.log(`Karma Farming Subs: Total subs in KF list: ${uniqueSubs.length}`);

    const promises = Object.entries(subsToCheck).map(([sub, date]) => getAccountsFromSub(sub, date, context));
    const accountsToCheck = compact(await Promise.all(promises));

    if (accountsToCheck.length > 0) {
        await context.redis.zAdd(CHECK_DATE_KEY, ...accountsToCheck.map(item => ({ member: item.subredditName, score: new Date().getTime() })));
    }

    return uniq(accountsToCheck.map(item => item.accounts).flat());
}

async function evaluateAndHandleUser (username: string, variables: Record<string, JSONValue>, context: JobContext) {
    const userStatus = await getUserStatus(username, context);
    if (userStatus) {
        return false;
    }

    const evaluationResults = await evaluateUserAccount(username, variables, context, true);

    if (evaluationResults.length === 0) {
        return;
    }

    if (evaluationResults.every(item => !item.metThreshold)) {
        return;
    }

    if (!evaluationResults.some(item => item.canAutoBan)) {
        return;
    }

    const hasContinuousNSFWHistory = await userHasContinuousNSFWHistory(username, context);

    const user = await getUserExtended(username, context);
    if (!user) {
        return;
    }

    const newDetails: UserDetails = {
        userStatus: hasContinuousNSFWHistory ? UserStatus.Pending : UserStatus.Banned,
        lastUpdate: new Date().getTime(),
        submitter: context.appName,
        operator: context.appName,
        trackingPostId: "",
    };

    const submission: AsyncSubmission = {
        user,
        details: newDetails,
        commentToAdd: json2md([
            { p: "This user was detected automatically through proactive bot hunting activity." },
            { p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` },
        ]),
        immediate: false,
    };

    const result = await queuePostCreation(submission, context);
    if (result === PostCreationQueueResult.Queued) {
        console.log(`Karma Farming Subs: Queued post creation for ${username}`);
    } else {
        console.error(`Karma Farming Subs: Failed to queue post creation for ${username}. Reason: ${result}`);
    }

    const evaluationResultsToStore = evaluationResults.filter(result => result.canAutoBan);
    await storeAccountInitialEvaluationResults(username, evaluationResultsToStore, context);
}

const ACCOUNTS_QUEUED_KEY = "KarmaFarmingSubsAccountsQueue";

async function isEvaluationDisabled (context: JobContext): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings(context);
    return !controlSubSettings.proactiveEvaluationEnabled || controlSubSettings.evaluationDisabled;
}

export async function queueKarmaFarmingAccounts (accounts: string[], context: TriggerContext | JobContext) {
    await context.redis.zAdd(ACCOUNTS_QUEUED_KEY, ...accounts.map(username => ({ member: username, score: new Date().getTime() })));
}

export async function queueKarmaFarmingSubs (_: unknown, context: JobContext) {
    if (await isEvaluationDisabled(context)) {
        console.log("Karma Farming Subs: Proactive evaluation is disabled.");
        return;
    }

    let accounts = await getDistinctAccounts(context);
    const initialCount = accounts.length;

    // Filter out accounts already known to Bot Bouncer;
    const knownAccounts = await getAllKnownUsers(context);
    accounts = accounts.filter(account => !knownAccounts.includes(account));
    const filteredCount = initialCount - accounts.length;

    await queueKarmaFarmingAccounts(accounts, context);
    console.log(`Karma Farming Subs: Queued ${accounts.length} ${pluralize("account", accounts.length)} to evaluate, filtered ${filteredCount} ${pluralize("account", filteredCount)} already known to Bot Bouncer`);
}

export async function evaluateKarmaFarmingSubs (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const nextScheduledRun = CronExpressionParser.parse(EVALUATE_KARMA_FARMING_SUBS_CRON).next().toDate();
    if (nextScheduledRun < addSeconds(new Date(), 30)) {
        console.log(`Karma Farming Subs: Next scheduled run is too soon, skipping this run.`);
        return;
    }

    const runLimit = addSeconds(new Date(), 10);
    const batchSize = 10;

    const totalQueued = await context.redis.zCard(ACCOUNTS_QUEUED_KEY);

    if (event.data?.firstRun) {
        console.log(`Karma Farming Subs: First run in this batch, total queued: ${totalQueued}`);
    }

    const accounts = (await context.redis.zRange(ACCOUNTS_QUEUED_KEY, 0, batchSize - 1)).map(item => item.member);
    if (accounts.length === 0) {
        console.log("Karma Farming Subs: No accounts to evaluate.");
        return;
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
        runAt: addSeconds(new Date(), 5),
    });

    let processed = 0;

    const variables = await getEvaluatorVariables(context);

    while (new Date() < runLimit) {
        const account = accounts.shift();
        if (!account) {
            break;
        }

        await context.redis.zRem(ACCOUNTS_QUEUED_KEY, [account]);

        try {
            await evaluateAndHandleUser(account, variables, context);
        } catch (error) {
            console.error(`Karma Farming Subs: Error evaluating ${account}: ${error}`);
        }

        processed += 1;
    }

    const remaining = totalQueued - processed;
    if (remaining > 0) {
        console.log(`Karma Farming Subs: ${processed} checked, ${remaining} ${pluralize("account", remaining)} remaining to evaluate`);
    } else {
        console.log(`Karma Farming Subs: Finished checking remaining ${processed} ${pluralize("account", processed)}.`);
    }
}
