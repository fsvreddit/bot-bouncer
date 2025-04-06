import { JobContext, JSONObject, Post, ScheduledJobEvent, ZMember } from "@devvit/public-api";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { uniq } from "lodash";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { evaluateUserAccount } from "./handleControlSubAccountEvaluation.js";
import { getControlSubSettings } from "./settings.js";
import { addMinutes, addSeconds } from "date-fns";
import { getUserExtended } from "./extendedDevvit.js";
import { createNewSubmission } from "./postCreation.js";
import pluralize from "pluralize";

const CHECK_DATE_KEY = "KarmaFarmingSubsCheckDates";

async function getAccountsFromSub (subredditName: string, since: Date, context: JobContext): Promise<string[]> {
    let posts: Post[];
    try {
        posts = await context.reddit.getNewPosts({
            subredditName,
            limit: 100,
        }).all();
        await context.redis.zAdd(CHECK_DATE_KEY, { member: subredditName, score: new Date().getTime() });
    } catch (error) {
        console.error(`Karma Farming Subs: Error getting posts from ${subredditName}: ${error}`);
        return [];
    }

    return uniq(posts.filter(post => post.createdAt > since).map(post => post.authorName));
}

function lastCheckDateForSub (subredditName: string, lastCheckDates: ZMember[]): Date {
    const lastCheckDate = lastCheckDates.find(item => item.member === subredditName);
    return new Date(lastCheckDate?.score ?? 0);
}

async function getDistinctAccounts (context: JobContext): Promise<string[]> {
    const variables = await getEvaluatorVariables(context);
    const karmaFarmingSubs = variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];
    const karmaFarmingSubsNSFW = variables["generic:karmafarminglinksubsnsfw"] as string[] | undefined ?? [];

    const distinctSubs: string[] = [];
    for (const sub of [...karmaFarmingSubs, ...karmaFarmingSubsNSFW]) {
        if (!distinctSubs.some(item => item.toLowerCase() === sub.toLowerCase())) {
            distinctSubs.push(sub);
        }
    }

    console.log(`Karma Farming Subs: Checking ${distinctSubs.length} distinct subs`);

    const lastDates = await context.redis.zRange(CHECK_DATE_KEY, 0, -1);

    const promises = distinctSubs.map(sub => getAccountsFromSub(sub, lastCheckDateForSub(sub, lastDates), context));
    const results = await Promise.all(promises);

    return uniq(results.flat());
}

async function evaluateAndHandleUser (username: string, context: JobContext): Promise<boolean> {
    const userStatus = await getUserStatus(username, context);
    if (userStatus) {
        return false;
    }

    const evaluationResults = await evaluateUserAccount(username, context, false);

    if (evaluationResults.length === 0) {
        return false;
    }

    if (evaluationResults.every(item => !item.metThreshold)) {
        return false;
    }

    if (!evaluationResults.some(item => item.canAutoBan)) {
        return false;
    }

    const user = await getUserExtended(username, context);
    if (!user) {
        return false;
    }

    const newDetails: UserDetails = {
        userStatus: UserStatus.Banned,
        lastUpdate: new Date().getTime(),
        submitter: context.appName,
        operator: context.appName,
        trackingPostId: "",
    };

    const newPost = await createNewSubmission(user, newDetails, context);

    let text = "This user was detected automatically through proactive bot hunting activity.\n\n";
    text += `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*`;
    await newPost.addComment({ text });

    console.log(`Karma Farming Subs: Banned ${username}`);

    return true;
}

export async function evaluateKarmaFarmingSubs (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const sweepInProgressKey = "KarmaFarmingSubsSweepInProgress";

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.proactiveEvaluationEnabled || controlSubSettings.evaluationDisabled) {
        console.log("Karma Farming Subs: Proactive evaluation is disabled.");
        return;
    }

    let accounts = event.data?.accounts as string[] | undefined;
    if (!accounts) {
        const sweepInProgress = await context.redis.exists(sweepInProgressKey);
        if (sweepInProgress) {
            console.log("Karma Farming Subs: Sweep already in progress. Skipping this run.");
            return;
        }

        accounts = await getDistinctAccounts(context);
        console.log("Karma Farming Subs: First batch starting.");
    }

    await context.redis.set(sweepInProgressKey, new Date().getTime().toString(), { expiration: addMinutes(new Date(), 5) });

    const batchSize = 10;
    let processed = 0;
    let userBanned = false;

    if (accounts.length > batchSize) {
        console.log(`Karma Farming Subs: Checking ${batchSize} accounts out of ${accounts.length}`);
    } else {
        console.log(`Karma Farming Subs: Checking final ${accounts.length} ${pluralize("account", accounts.length)}`);
    }

    while (processed < batchSize) {
        const username = accounts.shift();
        if (!username) {
            break;
        }

        try {
            userBanned = await evaluateAndHandleUser(username, context);
            if (userBanned) {
                // Only let one user be banned per run to avoid rate limiting
                break;
            }
        } catch (error) {
            console.error(`Karma Farming Subs: Error evaluating ${username}: ${error}`);
        }

        processed++;
    }

    if (accounts.length > 0) {
        const nextRunSeconds = userBanned ? 30 : 0;
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
            runAt: addSeconds(new Date(), nextRunSeconds),
            data: { accounts },
        });
    } else {
        await context.redis.del(sweepInProgressKey);
        console.log("Karma Farming Subs: Finished checking all accounts.");
    }
}
