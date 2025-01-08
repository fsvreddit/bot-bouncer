import { Comment, JobContext, JSONObject, JSONValue, Post, ScheduledJobEvent } from "@devvit/public-api";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { uniq } from "lodash";
import { CONTROL_SUBREDDIT, EVALUATE_KARMA_FARMING_SUBS, PostFlairTemplate } from "./constants.js";
import { getUserOrUndefined } from "./utility.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";
import { UserEvaluatorBase } from "./userEvaluation/UserEvaluatorBase.js";
import pluralize from "pluralize";
import { getUserStatus } from "./dataStore.js";
import { EvaluatorStats } from "./handleControlSubAccountEvaluation.js";
import { getControlSubSettings } from "./settings.js";
import { addSeconds } from "date-fns";

const CHECK_DATE_KEY = "KarmaFarmingSubsCheckDate";

async function getAccountsFromSub (subredditName: string, since: Date, context: JobContext): Promise<string[]> {
    const posts = await context.reddit.getNewPosts({
        subredditName,
        limit: 100,
    }).all();

    return uniq(posts.filter(post => post.createdAt > since).map(post => post.authorName));
}

async function getDistinctAccounts (context: JobContext): Promise<string[]> {
    const variables = await getEvaluatorVariables(context);
    const karmaFarmingSubs = variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];

    const lastDateVal = await context.redis.get(CHECK_DATE_KEY);
    const lastDate = lastDateVal ? new Date(parseInt(lastDateVal)) : new Date(0);

    const promises = karmaFarmingSubs.map(sub => getAccountsFromSub(sub, lastDate, context));
    const results = await Promise.all(promises);

    await context.redis.set(CHECK_DATE_KEY, new Date().getTime().toString());

    return uniq(results.flat());
}

async function evaluateUser (username: string, variables: Record<string, JSONValue>, context: JobContext) {
    const userStatus = await getUserStatus(username, context);
    if (userStatus) {
        return;
    }

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return;
    }

    let userEligible = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.preEvaluateUser(user)) {
            userEligible = true;
        }
    }

    if (!userEligible) {
        return;
    }

    let userItems: (Post | Comment)[];
    try {
        userItems = await context.reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            limit: 100,
        }).all();
    } catch {
        // Error retrieving user history, likely shadowbanned.
        return;
    }

    const detectedBots: UserEvaluatorBase[] = [];
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        const isABot = evaluator.evaluate(user, userItems);
        if (isABot) {
            detectedBots.push(evaluator);
        }
    }

    if (detectedBots.length === 0) {
        return;
    }

    if (detectedBots.every(bot => userItems.length < bot.banContentThreshold)) {
        return;
    }

    if (detectedBots.every(bot => !bot.canAutoBan)) {
        return;
    }

    console.log(`Karma Farming Subs: Detected bot ${username} in ${detectedBots.map(bot => bot.name).join(", ")}`);

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${username}`,
        url: `https://www.reddit.com/user/${username}`,
        flairId: PostFlairTemplate.Banned,
    });

    let text = "This user was detected automatically through proactive bot hunting activity.\n\n";
    text += `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*`;
    await newPost.addComment({ text });

    const redisKey = "EvaluatorStats";
    const existingStatsVal = await context.redis.get(redisKey);

    const allStats: Record<string, EvaluatorStats> = existingStatsVal ? JSON.parse(existingStatsVal) as Record<string, EvaluatorStats> : {};

    for (const bot of detectedBots) {
        const botStats = allStats[bot.name] ?? { hitCount: 0, lastHit: 0 };
        botStats.hitCount++;
        botStats.lastHit = new Date().getTime();
        allStats[bot.name] = botStats;
    }

    await context.redis.set(redisKey, JSON.stringify(allStats));
    console.log("Karma Farming Subs: Evaluator Stats updated", allStats);

    await context.reddit.setPostFlair({
        subredditName: CONTROL_SUBREDDIT,
        postId: newPost.id,
        flairTemplateId: PostFlairTemplate.Banned,
    });
}

export async function evaluateKarmaFarmingSubs (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.proactiveEvaluationEnabled || controlSubSettings.evaluationDisabled) {
        return;
    }

    let accounts = event.data?.accounts as string[] | undefined;
    if (!accounts) {
        accounts = await getDistinctAccounts(context);
        console.log("Karma Farming Subs: First batch starting.");
    }

    const batchSize = 5;

    const itemsToCheck = accounts.slice(0, batchSize);
    if (itemsToCheck.length === 0) {
        console.log("Karma Farming Subs: No accounts to check");
        return;
    }

    console.log(`Karma Farming Subs: Checking ${itemsToCheck.length} ${pluralize("account", itemsToCheck.length)} out of ${accounts.length}`);

    const variables = await getEvaluatorVariables(context);

    for (const username of itemsToCheck) {
        try {
            await evaluateUser(username, variables, context);
        } catch (error) {
            console.error(`Karma Farming Subs: Error evaluating ${username}: ${error}`);
        }
    }

    const remainingUsers = accounts.slice(batchSize);
    if (remainingUsers.length > 0) {
        await context.scheduler.runJob({
            name: EVALUATE_KARMA_FARMING_SUBS,
            runAt: addSeconds(new Date(), 30),
            data: { accounts: remainingUsers },
        });
    }
}
