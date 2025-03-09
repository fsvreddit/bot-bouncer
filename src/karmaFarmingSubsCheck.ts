import { JobContext, JSONObject, Post, ScheduledJobEvent } from "@devvit/public-api";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { uniq } from "lodash";
import { CONTROL_SUBREDDIT, EVALUATE_KARMA_FARMING_SUBS, PostFlairTemplate } from "./constants.js";
import { getUserStatus } from "./dataStore.js";
import { evaluateUserAccount } from "./handleControlSubAccountEvaluation.js";
import { getControlSubSettings } from "./settings.js";
import { addSeconds } from "date-fns";
import { getUserOrUndefined } from "./utility.js";

const CHECK_DATE_KEY = "KarmaFarmingSubsCheckDate";

async function getAccountsFromSub (subredditName: string, since: Date, context: JobContext): Promise<string[]> {
    let posts: Post[];
    try {
        posts = await context.reddit.getNewPosts({
            subredditName,
            limit: 100,
        }).all();
    } catch (error) {
        console.error(`Karma Farming Subs: Error getting posts from ${subredditName}: ${error}`);
        return [];
    }

    return uniq(posts.filter(post => post.createdAt > since).map(post => post.authorName));
}

async function getDistinctAccounts (context: JobContext): Promise<string[]> {
    const variables = await getEvaluatorVariables(context);
    const karmaFarmingSubs = variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];

    const lastDateVal = await context.redis.get(CHECK_DATE_KEY);
    const lastDate = lastDateVal ? new Date(parseInt(lastDateVal)) : new Date(0);

    const promises = uniq(karmaFarmingSubs).map(sub => getAccountsFromSub(sub, lastDate, context));
    const results = await Promise.all(promises);

    await context.redis.set(CHECK_DATE_KEY, new Date().getTime().toString());

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

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return false;
    }

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${username}`,
        url: `https://www.reddit.com/user/${username}`,
        flairId: PostFlairTemplate.Banned,
        nsfw: user.nsfw,
    });

    let text = "This user was detected automatically through proactive bot hunting activity.\n\n";
    text += `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*`;
    await newPost.addComment({ text });

    console.log(`Karma Farming Subs: Banned ${username}`);

    return true;
}

export async function evaluateKarmaFarmingSubs (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.proactiveEvaluationEnabled || controlSubSettings.evaluationDisabled) {
        console.log("Karma Farming Subs: Proactive evaluation is disabled.");
        return;
    }

    let accounts = event.data?.accounts as string[] | undefined;
    if (!accounts) {
        accounts = await getDistinctAccounts(context);
        console.log("Karma Farming Subs: First batch starting.");
    }

    const batchSize = 10;
    let processed = 0;

    console.log(`Karma Farming Subs: Checking up to ten accounts out of ${accounts.length}`);

    while (processed < batchSize) {
        const username = accounts.shift();
        if (!username) {
            break;
        }

        try {
            const userBanned = await evaluateAndHandleUser(username, context);
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
        await context.scheduler.runJob({
            name: EVALUATE_KARMA_FARMING_SUBS,
            runAt: addSeconds(new Date(), 30),
            data: { accounts },
        });
    } else {
        console.log("Karma Farming Subs: Finished checking all accounts.");
    }
}
