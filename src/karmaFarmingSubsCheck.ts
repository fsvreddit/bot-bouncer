import { JobContext, JSONValue, Post, ZMember } from "@devvit/public-api";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { compact, fromPairs, uniq } from "lodash";
import { CONTROL_SUBREDDIT, ControlSubredditJob, EVALUATE_KARMA_FARMING_SUBS_CRON } from "./constants.js";
import { getAllKnownUsers, getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { evaluateUserAccount, USER_EVALUATION_RESULTS_KEY, userHasContinuousNSFWHistory } from "./handleControlSubAccountEvaluation.js";
import { getControlSubSettings } from "./settings.js";
import { addSeconds, subMinutes, subWeeks } from "date-fns";
import { getUserExtended } from "./extendedDevvit.js";
import { AsyncSubmission, queuePostCreation } from "./postCreation.js";
import pluralize from "pluralize";
import json2md from "json2md";
import { CronExpressionParser } from "cron-parser";

const CHECK_DATE_KEY = "KarmaFarmingSubsCheckDates";

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
        accounts: uniq(posts.filter(post => post.createdAt > since).map(post => post.authorName)),
    };
}

function lastCheckDateForSub (subredditName: string, lastCheckDates: ZMember[]): Date {
    const lastCheckDate = lastCheckDates.find(item => item.member === subredditName);
    return new Date(lastCheckDate?.score ?? 0);
}

async function getDistinctAccounts (context: JobContext): Promise<string[]> {
    const variables = await getEvaluatorVariables(context);
    const karmaFarmingSubs = variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];
    const karmaFarmingSubsNSFW = variables["generic:karmafarminglinksubsnsfw"] as string[] | undefined ?? [];

    // Remove check dates older than a week.
    await context.redis.zRemRangeByScore(CHECK_DATE_KEY, 0, subWeeks(new Date(), 1).getTime());

    const lastDates = await context.redis.zRange(CHECK_DATE_KEY, 0, -1);

    const subsToCheck: Record<string, Date> = {};
    let subCount = 0;
    for (const sub of [...karmaFarmingSubs, ...karmaFarmingSubsNSFW]) {
        const lastCheckDate = lastCheckDateForSub(sub, lastDates);
        if (lastCheckDate < subMinutes(new Date(), 25)) {
            subsToCheck[sub] = lastCheckDate;
            subCount++;
        }
        if (subCount >= 50) {
            break;
        }
    }

    console.log(`Karma Farming Subs: Checking ${Object.keys(subsToCheck).length} distinct subs`);

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

    const evaluationResults = await evaluateUserAccount(username, variables, context, false);

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

    await queuePostCreation(submission, context);

    console.log(`Karma Farming Subs: Queued post creation for ${username}`);

    const evaluationResultsToStore = evaluationResults.filter(result => result.canAutoBan);
    if (evaluationResultsToStore.length > 0) {
        await context.redis.hSet(USER_EVALUATION_RESULTS_KEY, { [username]: JSON.stringify(evaluationResultsToStore) });
    }
}

const ACCOUNTS_QUEUED_KEY = "KarmaFarmingSubsAccountsQueued";

async function isEvaluationDisabled (context: JobContext): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings(context);
    return !controlSubSettings.proactiveEvaluationEnabled || controlSubSettings.evaluationDisabled;
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

    const accountsData = fromPairs(accounts.map(account => [account, account]));
    await context.redis.hSet(ACCOUNTS_QUEUED_KEY, accountsData);
    console.log(`Karma Farming Subs: Queued ${accounts.length} ${pluralize("account", accounts.length)} to evaluate, filtered ${filteredCount} ${pluralize("account", filteredCount)} already known to Bot Bouncer`);
}

export async function evaluateKarmaFarmingSubs (_: unknown, context: JobContext) {
    if (await isEvaluationDisabled(context)) {
        console.log("Karma Farming Subs: Proactive evaluation is disabled.");
        return;
    }

    const nextScheduledRun = CronExpressionParser.parse(EVALUATE_KARMA_FARMING_SUBS_CRON).next().toDate();
    if (nextScheduledRun < addSeconds(new Date(), 45)) {
        console.log(`Karma Farming Subs: Next scheduled run is too soon, skipping this run.`);
        return;
    }

    const runLimit = addSeconds(new Date(), 25);

    const accounts = await context.redis.hKeys(ACCOUNTS_QUEUED_KEY);
    if (accounts.length === 0) {
        console.log("Karma Farming Subs: No accounts to evaluate.");
        return;
    }

    let processed = 0;

    const variables = await getEvaluatorVariables(context);

    while (new Date() < runLimit && processed < 30) {
        const username = accounts.shift();
        if (!username) {
            break;
        }

        processed++;

        try {
            await evaluateAndHandleUser(username, variables, context);
        } catch (error) {
            console.error(`Karma Farming Subs: Error evaluating ${username}: ${error}`);
        }
        await context.redis.hDel(ACCOUNTS_QUEUED_KEY, [username]);
    }

    if (accounts.length > 0) {
        console.log(`Karma Farming Subs: ${processed} checked, ${accounts.length} ${pluralize("account", accounts.length)} remaining to evaluate`);
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
            runAt: new Date(),
        });
    } else {
        console.log(`Karma Farming Subs: Finished checking remaining ${processed} ${pluralize("account", processed)}.`);
    }
}
