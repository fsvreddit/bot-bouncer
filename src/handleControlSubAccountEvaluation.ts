import { Comment, JobContext, JSONObject, JSONValue, Post, ScheduledJobEvent, SubredditInfo, TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";
import { UserEvaluatorBase } from "./userEvaluation/UserEvaluatorBase.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { addWeeks, subMonths } from "date-fns";
import { getUserExtended } from "./extendedDevvit.js";
import { uniq } from "lodash";

export interface EvaluatorStats {
    hitCount: number;
    lastHit: number;
}

export interface EvaluationResult {
    botName: string;
    hitReason?: string;
    canAutoBan: boolean;
    metThreshold: boolean;
}

export async function evaluateUserAccount (username: string, variables: Record<string, JSONValue>, context: JobContext, verbose: boolean): Promise<EvaluationResult[]> {
    const user = await getUserExtended(username, context);
    if (!user) {
        if (verbose) {
            console.log(`Evaluation: ${username} has already been shadowbanned`);
        }
        return [];
    }

    let userItems: (Post | Comment)[] | undefined;
    const detectedBots: UserEvaluatorBase[] = [];

    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        const userEvaluateResult = await Promise.resolve(evaluator.preEvaluateUser(user));
        if (!userEvaluateResult) {
            continue;
        }

        if (userItems === undefined) {
            try {
                userItems = await context.reddit.getCommentsAndPostsByUser({
                    username,
                    sort: "new",
                    limit: 100,
                }).all();
            } catch {
                // Error retrieving user history, likely shadowbanned.
                if (verbose) {
                    console.log(`Evaluator: ${username} appears to be shadowbanned.`);
                }
                return [];
            }
        }

        let isABot;
        try {
            isABot = await Promise.resolve(evaluator.evaluate(user, userItems));
        } catch (error) {
            console.error(`Evaluator: ${username} threw an error during evaluation of ${evaluator.name}: ${error}`);
            return [];
        }
        if (isABot) {
            if (evaluator.name !== "CQS Tester") {
                console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.name} 💥`);
            }
            detectedBots.push(evaluator);
        } else if (evaluator.name === "Short TLC New Bot" && userItems.some(item => item.subredditName === "Frieren")) {
            console.log(`Evaluator for ${username} did not match ${evaluator.name}: ${evaluator.getReasons().join(", ")}`);
        }
    }

    if (detectedBots.length === 0) {
        return [];
    }

    const redisKey = "EvaluatorStats";
    const existingStatsVal = await context.redis.get(redisKey);

    const allStats: Record<string, EvaluatorStats> = existingStatsVal ? JSON.parse(existingStatsVal) as Record<string, EvaluatorStats> : {};

    for (const bot of detectedBots.filter(bot => bot.name !== "CQS Tester")) {
        const botStats = allStats[bot.name] ?? { hitCount: 0, lastHit: 0 };
        botStats.hitCount++;
        botStats.lastHit = new Date().getTime();
        allStats[bot.name] = botStats;
    }

    await context.redis.set(redisKey, JSON.stringify(allStats));

    const itemCount = userItems?.length ?? 0;
    return detectedBots.map(bot => ({ botName: bot.name, hitReason: bot.hitReason, canAutoBan: bot.canAutoBan, metThreshold: itemCount >= bot.banContentThreshold }));
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

    const variables = await getEvaluatorVariables(context);
    const evaluationResults = await evaluateUserAccount(username, variables, context, true);

    let reportReason: string | undefined;

    if (evaluationResults.length === 0) {
        reportReason = "Not detected as a bot via evaluation, needs manual review.";
    } else if (evaluationResults.every(result => !result.metThreshold)) {
        reportReason = `Possible bot via evaluation, but insufficient content: ${evaluationResults.map(result => result.botName).join(", ")}`;
    } else if (!evaluationResults.some(result => result.canAutoBan)) {
        reportReason = `Possible bot via evaluation, tagged as no-auto-ban: ${evaluationResults.map(result => result.botName).join(", ")}`;
    } else if (await userHasContinuousNSFWHistory(username, context)) {
        reportReason = "Possible bot via evaluation, but continuous NSFW history detected.";
    }

    if (reportReason) {
        const post = await context.reddit.getPostById(postId);
        await context.reddit.report(post, { reason: reportReason });
        if (!event.data?.skipSummary) {
            await createUserSummary(username, postId, context);
        }
        return;
    }

    await context.reddit.setPostFlair({
        subredditName: CONTROL_SUBREDDIT,
        postId,
        flairTemplateId: PostFlairTemplate.Banned,
    });

    const evaluationResultsToStore = evaluationResults.filter(result => result.canAutoBan);
    if (evaluationResultsToStore.length > 0) {
        await context.redis.hSet(USER_EVALUATION_RESULTS_KEY, { [username]: JSON.stringify(evaluationResultsToStore) });
    }

    console.log(`Evaluator: Post flair changed for ${username}`);
}

export const USER_EVALUATION_RESULTS_KEY = "UserEvaluationResults";

export async function getAccountInitialEvaluationResults (username: string, context: TriggerContext): Promise<EvaluationResult[]> {
    const results = await context.redis.hGet(USER_EVALUATION_RESULTS_KEY, username);
    if (!results) {
        return [];
    }

    return JSON.parse(results) as EvaluationResult[];
}

async function subIsNSFW (subredditName: string, context: TriggerContext): Promise<boolean> {
    const redisKey = `subisnsfw:${subredditName}`;
    const cachedValue = await context.redis.get(redisKey);
    if (cachedValue) {
        return JSON.parse(cachedValue) as boolean;
    }

    let subredditInfo: SubredditInfo | undefined;
    try {
        subredditInfo = await context.reddit.getSubredditInfoByName(subredditName);
    } catch {
        // Error retrieving subreddit info, likely gated or freshly banned.
    }

    const isNSFW = subredditInfo?.isNsfw ?? false;

    await context.redis.set(redisKey, JSON.stringify(isNSFW), { expiration: addWeeks(new Date(), 1) });
    console.log(`Subreddit ${subredditName} is NSFW: ${isNSFW}`);
    return isNSFW;
}

export async function userHasContinuousNSFWHistory (username: string, context: TriggerContext): Promise<boolean> {
    let posts = await context.reddit.getPostsByUser({
        username,
        sort: "new",
        limit: 1000,
        timeframe: "year",
    }).all();

    if (posts.length === 0) {
        return false;
    }

    const subNSFW: Record<string, boolean> = {};
    // Filter to just the last 6 months.
    posts = posts.filter(post => post.createdAt > subMonths(new Date(), 6));
    for (let month = new Date().getMonth() - 5; month <= new Date().getMonth(); month++) {
        const postsInMonth = posts.filter(post => post.createdAt.getMonth() === month);
        if (postsInMonth.length === 0) {
            return false;
        }

        if (postsInMonth.some(post => post.nsfw)) {
            continue;
        }

        for (const subreddit of uniq(postsInMonth.map(post => post.subredditName))) {
            subNSFW[subreddit] ??= await subIsNSFW(subreddit, context);
            if (subNSFW[subreddit]) {
                continue;
            }
        }

        // If we have a month with no NSFW posts and no NSFW subreddits, return false.
        return false;
    }

    return true;
}
