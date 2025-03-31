import { Comment, JobContext, JSONObject, Post, ScheduledJobEvent } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { ALL_EVALUATORS } from "./userEvaluation/allEvaluators.js";
import { UserEvaluatorBase } from "./userEvaluation/UserEvaluatorBase.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { subDays } from "date-fns";
import { getUserExtended } from "./extendedDevvit.js";

export interface EvaluatorStats {
    hitCount: number;
    lastHit: number;
}

interface EvaluationResult {
    botName: string;
    canAutoBan: boolean;
    metThreshold: boolean;
}

export async function evaluateUserAccount (username: string, context: JobContext, verbose: boolean): Promise<EvaluationResult[]> {
    const user = await getUserExtended(username, context);
    if (!user) {
        if (verbose) {
            console.log(`Evaluation: ${username} has already been shadowbanned`);
        }
        return [];
    }

    const variables = await getEvaluatorVariables(context);

    let userItems: (Post | Comment)[] | undefined;
    const detectedBots: UserEvaluatorBase[] = [];

    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        if (!evaluator.preEvaluateUser(user)) {
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

        const isABot = evaluator.evaluate(user, userItems);
        if (isABot) {
            console.log(`Evaluator: ${username} appears to be a bot via the evaluator: ${evaluator.name} 💥`);
            detectedBots.push(evaluator);
        } else {
            const regex = /^(?:[A-Z][a-z]+[_-]?){2}\\d{2,4}$/;
            if (evaluator.name === "Short Non-TLC" && userItems.some(item => item.subredditName === "Frieren" || item.subredditName === "justgalsbeingchicks") && regex.test(username) && user.createdAt > subDays(new Date(), 7)) {
                console.log(`Evaluator: ${username} didn't match ${evaluator.name}, but maybe should have done`);
                console.log(evaluator.getReasons().join(", "));
            }
        }
    }

    if (detectedBots.length === 0) {
        return [];
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

    const itemCount = userItems?.length ?? 0;
    return detectedBots.map(bot => ({ botName: bot.name, canAutoBan: bot.canAutoBan, metThreshold: itemCount >= bot.banContentThreshold }));
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

    const evaluationResults = await evaluateUserAccount(username, context, true);

    let reportReason: string | undefined;

    if (evaluationResults.length === 0) {
        reportReason = "Not detected as a bot via evaluation, needs manual review.";
    } else if (evaluationResults.every(result => !result.metThreshold)) {
        reportReason = `Possible bot via evaluation, but insufficient content: ${evaluationResults.map(result => result.botName).join(", ")}`;
    } else if (!evaluationResults.some(result => result.canAutoBan)) {
        reportReason = `Possible bot via evaluation, tagged as no-auto-ban: ${evaluationResults.map(result => result.botName).join(", ")}`;
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

    console.log(`Evaluator: Post flair changed for ${username}`);
}
