import { Comment, JobContext, JSONObject, JSONValue, Post, ScheduledJobEvent, SubredditInfo, TriggerContext, TxClientLike, UserSocialLink } from "@devvit/public-api";
import { ALL_EVALUATORS, UserEvaluatorBase } from "@fsvreddit/bot-bouncer-evaluation";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { addMonths, addWeeks, subMonths } from "date-fns";
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

export async function storeEvaluationStatistics (results: EvaluationResult[], context: JobContext) {
    if (results.length === 0) {
        return;
    }

    const redisKey = "EvaluatorStats";
    const existingStatsVal = await context.redis.get(redisKey);

    const allStats: Record<string, EvaluatorStats> = existingStatsVal ? JSON.parse(existingStatsVal) as Record<string, EvaluatorStats> : {};

    for (const result of results.filter(result => result.botName !== "CQS Tester")) {
        const botStats = allStats[result.botName] ?? { hitCount: 0, lastHit: 0 };
        botStats.hitCount++;
        botStats.lastHit = new Date().getTime();
        allStats[result.botName] = botStats;
    }

    await context.redis.set(redisKey, JSON.stringify(allStats));
}

export async function evaluateUserAccount (username: string, variables: Record<string, JSONValue>, context: JobContext, storeStats: boolean): Promise<EvaluationResult[]> {
    const user = await getUserExtended(username, context);
    if (!user) {
        return [];
    }

    let userItems: (Post | Comment)[] | undefined;
    let socialLinks: UserSocialLink[] | undefined;
    const detectedBots: UserEvaluatorBase[] = [];

    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, socialLinks, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        const userEvaluateResult = await Promise.resolve(evaluator.preEvaluateUser(user));
        if (!socialLinks && evaluator.socialLinks) {
            socialLinks = evaluator.socialLinks;
        }

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
                return [];
            }
        }

        let isABot;
        try {
            isABot = await Promise.resolve(evaluator.evaluate(user, userItems));
            if (!socialLinks && evaluator.socialLinks) {
                socialLinks = evaluator.socialLinks;
            }
        } catch (error) {
            console.error(`Evaluator: ${username} threw an error during evaluation of ${evaluator.name}: ${error}`);
            return [];
        }
        if (isABot) {
            console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.name} 💥`);
            if (evaluator.name.includes("Bot Group") && evaluator.hitReasons && evaluator.hitReasons.length > 0) {
                console.log(`Evaluator: Hit reasons: ${evaluator.hitReasons.join(", ")}`);
            }
            detectedBots.push(evaluator);
        }
    }

    if (detectedBots.length === 0) {
        return [];
    }

    const itemCount = userItems?.length ?? 0;

    const results: EvaluationResult[] = [];

    for (const bot of detectedBots) {
        const metThreshold = itemCount >= bot.banContentThreshold;
        if (!bot.hitReasons || bot.hitReasons.length === 0) {
            results.push({ botName: bot.name, canAutoBan: bot.canAutoBan, metThreshold });
        } else {
            results.push(...bot.hitReasons.map(hitReason => ({
                botName: bot.name,
                hitReason,
                canAutoBan: bot.canAutoBan,
                metThreshold,
            })));
        }
    }

    if (storeStats) {
        await storeEvaluationStatistics(results, context);
    }

    return results;
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
        if (currentStatus?.submitter) {
            reportReason += ` Submitted by ${currentStatus.submitter}`;
        }
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
    await storeAccountInitialEvaluationResults(username, evaluationResultsToStore, context);

    console.log(`Evaluator: Post flair changed for ${username}`);
}

function getEvaluationResultsKey (username: string): string {
    return `evaluationResults:${username}`;
}

export async function storeAccountInitialEvaluationResults (username: string, results: EvaluationResult[], context: TriggerContext) {
    if (results.length === 0) {
        return;
    }

    const resultsToStore: EvaluationResult[] = results.map(result => ({
        botName: result.botName,
        hitReason: result.hitReason && result.hitReason.length > 1000 ? `${result.hitReason.substring(0, 1000)}...` : result.hitReason,
        canAutoBan: result.canAutoBan,
        metThreshold: result.metThreshold,
    }));

    const resultsKey = getEvaluationResultsKey(username);
    await context.redis.set(resultsKey, JSON.stringify(resultsToStore), { expiration: addMonths(new Date(), 12) });
}

export async function getAccountInitialEvaluationResults (username: string, context: TriggerContext): Promise<EvaluationResult[]> {
    const results = await context.redis.get(getEvaluationResultsKey(username));

    if (!results) {
        return [];
    }

    return JSON.parse(results) as EvaluationResult[];
}

export async function deleteAccountInitialEvaluationResults (username: string, txn: TxClientLike) {
    await txn.del(getEvaluationResultsKey(username));
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
