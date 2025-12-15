import { Comment, JobContext, JSONObject, JSONValue, Post, ScheduledJobEvent, SubredditInfo, TriggerContext, UserSocialLink } from "@devvit/public-api";
import { ALL_EVALUATORS, HitReason, UserEvaluatorBase } from "@fsvreddit/bot-bouncer-evaluation";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { addMonths, addWeeks, subMonths } from "date-fns";
import { getUserExtended } from "./extendedDevvit.js";
import _ from "lodash";
import { getSubmitterSuccessRate } from "./statistics/submitterStatistics.js";

export interface EvaluatorStats {
    hitCount: number;
    lastHit: number;
}

export interface EvaluationResult {
    botName: string;
    hitReason?: HitReason;
    canAutoBan: boolean;
    metThreshold: boolean;
}

export async function evaluateUserAccount (username: string, variables: Record<string, JSONValue>, context: JobContext): Promise<EvaluationResult[]> {
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
                console.log(`Evaluator: Hit reasons: ${evaluator.hitReasons.map(item => typeof item === "string" ? item : item.reason).join(", ")}`);
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

    const variables = await getEvaluatorVariables(context);
    const evaluationResults = await evaluateUserAccount(username, variables, context);

    const evaluationResultsToStore = evaluationResults.filter(result => result.canAutoBan);
    await storeAccountInitialEvaluationResults(username, evaluationResultsToStore, context);

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus && currentStatus.userStatus !== UserStatus.Pending) {
        console.log(`Evaluation: ${username} has already been classified`);
        return;
    }

    let reportReason: string | undefined;

    if (evaluationResults.length === 0) {
        reportReason = "Needs manual review.";
    } else if (evaluationResults.every(result => !result.metThreshold)) {
        reportReason = `Possible bot via evaluation, but insufficient content: ${evaluationResults.map(result => result.botName).join(", ")}`;
    } else if (!evaluationResults.some(result => result.canAutoBan)) {
        reportReason = `Possible bot via evaluation, tagged as no-auto-ban: ${evaluationResults.map(result => result.botName).join(", ")}`;
    } else if (await userHasContinuousNSFWHistory(username, context)) {
        reportReason = "Possible bot via evaluation, but continuous NSFW history detected.";
    }

    if (reportReason) {
        if (currentStatus?.submitter && !currentStatus.submitter.startsWith(context.appName)) {
            reportReason += ` Submitted by ${currentStatus.submitter}`;
            const submitterSuccessRate = await getSubmitterSuccessRate(currentStatus.submitter, context);
            if (submitterSuccessRate !== undefined) {
                reportReason += ` (${submitterSuccessRate}%)`;
            }
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

    console.log(`Evaluator: Post flair changed for ${username}`);
}

function getEvaluationResultsKey (username: string): string {
    return `evaluationResults:${username}`;
}

function truncatedHitReason (hitReason?: HitReason): HitReason | undefined {
    if (!hitReason) {
        return;
    }
    if (typeof hitReason === "string") {
        return hitReason.length > 500 ? `${hitReason.substring(0, 500)}...` : hitReason;
    } else {
        return {
            reason: hitReason.reason.length > 500 ? `${hitReason.reason.substring(0, 500)}...` : hitReason.reason,
            details: hitReason.details.map(detail => ({
                key: detail.key,
                value: detail.value.length > 500 ? `${detail.value.substring(0, 500)}...` : detail.value,
            })),
        };
    }
}

export async function storeAccountInitialEvaluationResults (username: string, results: EvaluationResult[], context: TriggerContext) {
    if (results.length === 0) {
        return;
    }

    const resultsToStore: EvaluationResult[] = results.map(result => ({
        botName: result.botName,
        hitReason: truncatedHitReason(result.hitReason),
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

export async function deleteAccountInitialEvaluationResults (username: string, context: TriggerContext) {
    await context.redis.del(getEvaluationResultsKey(username));
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

        for (const subreddit of _.uniq(postsInMonth.map(post => post.subredditName))) {
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
