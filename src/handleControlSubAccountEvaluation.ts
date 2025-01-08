import { Comment, JobContext, JSONObject, Post, ScheduledJobEvent } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { getUserOrUndefined } from "./utility.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";
import { UserEvaluatorBase } from "./userEvaluation/UserEvaluatorBase.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { createUserSummary } from "./UserSummary/userSummary.js";

export interface EvaluatorStats {
    hitCount: number;
    lastHit: number;
}

export async function handleControlSubAccountEvaluation (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const username = event.data?.username as string | undefined;
    const postId = event.data?.postId as string | undefined;

    if (!username || !postId) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus && currentStatus.userStatus !== UserStatus.Pending) {
        console.log(`Evaluation: ${username} has already been classified`);
        return;
    }

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        console.log(`Evaluation: ${username} has already been shadowbanned`);
        return;
    }

    const variables = await getEvaluatorVariables(context);

    let userEligible = false;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.preEvaluateUser(user)) {
            userEligible = true;
        }
    }

    if (!userEligible) {
        console.log(`Evaluator: ${username} does not pass any user pre-checks.`);
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
        console.log(`Evaluator: ${username} appears to have been shadowbanned since post made.`);
        const post = await context.reddit.getPostById(postId);
        await context.reddit.report(post, { reason: "Account appears to be shadowbanned already, needs manual review." });
        return;
    }

    const detectedBots: UserEvaluatorBase[] = [];

    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        const isABot = evaluator.evaluate(user, userItems);
        if (isABot) {
            console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.name}`);
            detectedBots.push(evaluator);
        } else {
            console.log(`Evaluator: ${evaluator.name} did not match: ${evaluator.getReasons().join(", ")}`);
        }
    }

    if (detectedBots.length === 0) {
        console.log(`Evaluator: ${username} does not appear to be a bot via evaluators.`);
        const post = await context.reddit.getPostById(postId);
        await context.reddit.report(post, { reason: "Not detected as a bot via evaluation, needs manual review." });
        await createUserSummary(username, postId, context);
        return;
    }

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
    console.log("Evaluator: Stats updated", allStats);

    if (detectedBots.every(bot => userItems.length < bot.banContentThreshold)) {
        console.log(`Evaluator: ${username} does not have enough content for automatic evaluation.`);
        const post = await context.reddit.getPostById(postId);
        await context.reddit.report(post, { reason: `Possible bot via evaluation, but insufficient content: ${detectedBots.map(bot => bot.name).join(", ")}` });
        await createUserSummary(username, postId, context);
        return;
    }

    if (detectedBots.every(bot => !bot.canAutoBan)) {
        console.log(`Evaluator: Cannot autoban.`);
        const post = await context.reddit.getPostById(postId);
        await context.reddit.report(post, { reason: `Possible bot via evaluation, tagged as no-auto-ban: ${detectedBots.map(bot => bot.name).join(", ")}` });
        await createUserSummary(username, postId, context);
        return;
    }

    await context.reddit.setPostFlair({
        subredditName: CONTROL_SUBREDDIT,
        postId,
        flairTemplateId: PostFlairTemplate.Banned,
    });

    console.log(`Evaluator: Post flair changed for ${username}`);
}
