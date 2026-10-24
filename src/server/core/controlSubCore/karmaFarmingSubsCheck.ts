import { context, Post, reddit, redis, scheduler, TaskRequest, ZMember } from "@devvit/web/server";
import { getEvaluatorVariables } from "../userEvaluation";
import { addMinutes, addSeconds, differenceInMinutes, subMinutes, subWeeks } from "date-fns";
import { JsonValue } from "@devvit/web/shared";
import { AsyncSubmission, CONTROL_SUBREDDIT, ControlSubredditJob, evaluateUserAccount, getAllKnownUsers, getControlSubSettings, getUserStatus, isUserAlreadyQueued, PostCreationQueueResult, promotePositionInQueue, queuePostCreation, storeAccountInitialEvaluationResults, UserDetails, userHasContinuousNSFWHistory } from "..";
import { getUserExtended, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import json2md from "json2md";
import pluralize from "pluralize";
import { EvaluateKarmaFarmingSubsEventData } from "../../tasks";
import { compact, uniq } from "lodash-es";

export const CHECK_DATE_KEY = "KarmaFarmingSubsCheckDates";

interface AccountsToCheck {
    subredditName: string;
    accounts: string[];
}

async function getAccountsFromSub (subredditName: string, since: Date): Promise<AccountsToCheck | undefined> {
    let posts: Post[];
    try {
        posts = await reddit.getNewPosts({
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

async function getDistinctAccounts (): Promise<string[]> {
    const variables = await getEvaluatorVariables();
    const karmaFarmingSubs = variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];
    const karmaFarmingSubsNSFW = variables["generic:karmafarminglinksubsnsfw"] as string[] | undefined ?? [];
    const uniqueSubs = uniq([...karmaFarmingSubs, ...karmaFarmingSubsNSFW]);

    // Remove check dates older than a week.
    await redis.zRemRangeByScore(CHECK_DATE_KEY, 0, subWeeks(new Date(), 1).getTime());

    const lastDates = await redis.zRange(CHECK_DATE_KEY, 0, -1);

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

    const promises = Object.entries(subsToCheck).map(([sub, date]) => getAccountsFromSub(sub, date));
    const accountsToCheck = compact(await Promise.all(promises));

    if (accountsToCheck.length > 0) {
        await redis.zAdd(CHECK_DATE_KEY, ...accountsToCheck.map(item => ({ member: item.subredditName, score: new Date().getTime() })));
    }

    return uniq(accountsToCheck.map(item => item.accounts).flat());
}

async function evaluateAndHandleUser (username: string, variables: Record<string, JsonValue>) {
    const userStatus = await getUserStatus(username);
    if (userStatus) {
        return false;
    }

    const evaluationResults = await evaluateUserAccount({
        username,
        variables,
        throwOnError: true,
    });

    if (evaluationResults.length === 0) {
        return;
    }

    if (evaluationResults.every(item => !item.metThreshold)) {
        return;
    }

    if (!evaluationResults.some(item => item.canAutoBan)) {
        return;
    }

    const hasContinuousNSFWHistory = await userHasContinuousNSFWHistory(username);

    const user = await getUserExtended(username);
    if (!user) {
        return;
    }

    const newDetails: UserDetails = {
        userStatus: hasContinuousNSFWHistory ? UserStatus.Pending : UserStatus.Banned,
        lastUpdate: new Date().getTime(),
        submitter: context.appSlug,
        operator: context.appSlug,
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
        evaluatorsChecked: evaluationResults.length > 0,
    };

    const [result] = await queuePostCreation([submission]);
    if (result === PostCreationQueueResult.Queued) {
        console.log(`Karma Farming Subs: Queued post creation for ${username}`);
    } else if (result === PostCreationQueueResult.AlreadyInQueue) {
        console.log(`Karma Farming Subs: Post creation for ${username} is already in the queue, promoting position.`);
        await promotePositionInQueue(username);
    } else {
        console.error(`Karma Farming Subs: Failed to queue post creation for ${username}. Reason: ${result}`);
    }

    const evaluationResultsToStore = evaluationResults.filter(result => result.canAutoBan);
    await storeAccountInitialEvaluationResults(username, evaluationResultsToStore);
}

const ACCOUNTS_QUEUED_KEY = "KarmaFarmingSubsAccountsQueue";

async function isEvaluationDisabled (): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings();
    return !controlSubSettings.proactiveEvaluationEnabled || controlSubSettings.evaluationDisabled;
}

export async function queueKarmaFarmingAccounts (accounts: string[]) {
    const entriesToAdd: ZMember[] = [];
    const baseline = Date.now();
    accounts.forEach((username, index) => {
        entriesToAdd.push({ member: username, score: baseline + index });
    });
    await redis.global.zAdd(ACCOUNTS_QUEUED_KEY, ...entriesToAdd);
}

export async function queueKarmaFarmingSubs () {
    if (await isEvaluationDisabled()) {
        console.log("Karma Farming Subs: Proactive evaluation is disabled.");
        return;
    }

    let accounts = await getDistinctAccounts();
    const initialCount = accounts.length;

    // Filter out accounts already known to Bot Bouncer;
    const knownAccounts = await getAllKnownUsers();
    accounts = accounts.filter(account => !knownAccounts.includes(account));
    const filteredCount = initialCount - accounts.length;

    await queueKarmaFarmingAccounts(accounts);
    console.log(`Karma Farming Subs: Queued ${accounts.length} ${pluralize("account", accounts.length)} to evaluate, filtered ${filteredCount} ${pluralize("account", filteredCount)} already known to Bot Bouncer`);
}

async function rebalanceCohorts () {
    const entriesInQueue = await redis.global.zCard(ACCOUNTS_QUEUED_KEY);
    if (entriesInQueue > 20000) {
        console.warn(`Karma Farming Subs: Queue has ${entriesInQueue} entries, skipping rebalance to avoid excessive operations.`);
        return;
    }

    const allAccounts = await redis.global.zRange(ACCOUNTS_QUEUED_KEY, 0, -1);
    const evenAccounts = allAccounts.filter(item => item.score % 2 === 0);
    const oddAccounts = allAccounts.filter(item => item.score % 2 === 1);

    const difference = evenAccounts.length - oddAccounts.length;
    if (Math.abs(difference) <= 50 || allAccounts.length < 100) {
        return;
    }

    let accountsToMove: ZMember[];
    if (difference > 0) {
        // Move from evens to odds
        accountsToMove = evenAccounts.slice(0, Math.floor(difference / 2));
    } else {
        // Move from odds to evens
        accountsToMove = oddAccounts.slice(0, Math.floor(-difference / 2));
    }

    await redis.global.zAdd(ACCOUNTS_QUEUED_KEY, ...accountsToMove.map(item => ({ member: item.member, score: item.score + 1 })));
    console.log(`Karma Farming Subs: Rebalanced cohorts by moving ${accountsToMove.length} ${pluralize("account", accountsToMove.length)} of ${allAccounts.length} total queued accounts.`);
}

export async function evaluateKarmaFarmingSubs (event: TaskRequest<EvaluateKarmaFarmingSubsEventData>) {
    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Karma Farming Subs: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    if (event.data.firstRun && !event.data.cohort) {
        if (await hasEventBeenHandled(`job:${ControlSubredditJob.EvaluateKarmaFarmingSubs}`, { expiration: addSeconds(new Date(), 5) })) {
            console.warn(`Karma Farming Subs: First run for job ${ControlSubredditJob.EvaluateKarmaFarmingSubs} has already been handled, skipping.`);
            return;
        }
        try {
            await rebalanceCohorts();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const entriesInQueue = await redis.global.zCard(ACCOUNTS_QUEUED_KEY);
            console.error(`Karma Farming Subs: Error rebalancing cohorts. Entries in queue: ${entriesInQueue} Error: ${message}.`);
        }

        await Promise.all([
            scheduler.runJob<EvaluateKarmaFarmingSubsEventData>({
                name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
                runAt: new Date(),
                data: {
                    firstRun: true,
                    cohort: "evens",
                    jobGuid: crypto.randomUUID(),
                },
            }),
            scheduler.runJob<EvaluateKarmaFarmingSubsEventData>({
                name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
                runAt: new Date(),
                data: {
                    firstRun: true,
                    cohort: "odds",
                    jobGuid: crypto.randomUUID(),
                },
            }),
        ]);
        return;
    }

    const cohort = event.data.cohort;
    if (!cohort) {
        console.error("Karma Farming Subs: Invalid or missing cohort.");
        return;
    }

    const inProgressKey = `KarmaFarmingSubsOngoing:${cohort}`;
    if (event.data.firstRun && await redis.exists(inProgressKey)) {
        return;
    }

    await redis.set(inProgressKey, "true", { expiration: addSeconds(new Date(), 30) });

    const cooldownKey = `KarmaFarmingSubsCooldown`;
    if (await redis.exists(cooldownKey)) {
        console.log("Karma Farming Subs: Cooldown active, skipping evaluation.");
        return;
    }

    const accounts = await redis.global.zRange(ACCOUNTS_QUEUED_KEY, 0, 9999)
        .then((allAccounts) => {
            if (cohort === "evens") {
                return allAccounts.filter(item => item.score % 2 === 0);
            } else {
                return allAccounts.filter(item => item.score % 2 !== 0);
            }
        });

    if (accounts.length === 0) {
        console.log("Karma Farming Subs: No accounts to evaluate.");
        return;
    }

    let processed = 0;
    const totalQueued = accounts.length;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstDate = new Date(accounts[0]!.score);

    const variables = await getEvaluatorVariables();
    const controlSubSettings = await getControlSubSettings();

    const chunk = accounts.slice(0, controlSubSettings.proactiveEvaluationBatchSize ?? 10).map(item => item.member);

    let failedInBatch = 0;

    await Promise.all(chunk.map(async (username) => {
        await redis.global.zRem(ACCOUNTS_QUEUED_KEY, [username]);

        if (await isUserAlreadyQueued(username)) {
            await promotePositionInQueue(username);
            processed++;
            return;
        }

        try {
            await evaluateAndHandleUser(username, variables);
        } catch (error) {
            console.error(`Karma Farming Subs: Error evaluating ${username}: ${error}`);
            failedInBatch++;
        }

        processed += 1;
    }));

    if (failedInBatch > 3) {
        await redis.set(cooldownKey, "true", { expiration: addMinutes(new Date(), 2) });
    }

    const remaining = totalQueued - processed;
    if (remaining > 0) {
        let message = `Karma Farming Subs: ${processed} checked, ${remaining} ${pluralize("account", remaining)} remaining, ${cohort}`;
        const backlog = differenceInMinutes(new Date(), firstDate);
        if (backlog > 5) {
            message += `, backlog: ${backlog} ${pluralize("minute", backlog)}`;
        }
        console.log(message);

        await scheduler.runJob<EvaluateKarmaFarmingSubsEventData>({
            name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
            runAt: new Date(),
            data: { firstRun: false, cohort, jobGuid: crypto.randomUUID() },
        });
    } else {
        console.log(`Karma Farming Subs: Finished checking remaining ${processed} ${pluralize("account", processed)}.`);
    }
}
