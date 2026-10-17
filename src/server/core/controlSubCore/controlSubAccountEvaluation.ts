import { Comment, context, Post, reddit, redis, scheduler, settings, SubredditInfo, TaskRequest } from "@devvit/web/server";
import { JsonValue, T1, T3 } from "@devvit/web/shared";
import { EvaluateBotGroupAdvancedSubmitters, getSocialLinksWithCache, UserEvaluatorBase } from "@fsvreddit/bot-bouncer-evaluation";
import { getPostOrCommentById, getUserExtended, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { accountIsBotBouncerApp, ALL_RELEVANT_EVALUTORS, AppSetting, conditionallyCompressString, conditionallyDecompressString, CONTROL_SUBREDDIT, ControlSubredditJob, getControlSubSettings, getUserStatus, normaliseHitReason, normaliseHitReasons, PostFlairTemplate } from "..";
import { addMinutes, addSeconds, addWeeks, subMonths } from "date-fns";
import _ from "lodash";
import { HitReason, HitReasonDetailed, UserStatus } from "@fsvreddit/bot-bouncer-types";
import { EvaluateUserJobData, OpenAISummaryGatherData } from "../../tasks";
import { getEvaluatorVariables } from "../userEvaluation";
import { createUserSummary } from "./userSummary";
import { getSubmitterSuccessRate } from "./statistics";

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

interface EvaluateUserAccountOptions {
    username: string;
    variables: Record<string, JsonValue>;
    history?: (Post | Comment)[];
    throwOnError?: boolean;
    targetId?: T1 | T3;
}

export async function evaluateUserAccount (options: EvaluateUserAccountOptions, silent = false): Promise<EvaluationResult[]> {
    const user = await getUserExtended(options.username);
    if (!user) {
        return [];
    }

    const detectedBots: UserEvaluatorBase[] = [];

    const matchedEvaluators = await Promise.all(ALL_RELEVANT_EVALUTORS.map(async (Evaluator) => {
        const evaluatorInstance = new Evaluator([], undefined, options.variables);
        if (evaluatorInstance.evaluatorDisabled()) {
            return;
        }

        const preEvaluateResult = await Promise.resolve(evaluatorInstance.preEvaluateUser(user));
        if (preEvaluateResult) {
            return evaluatorInstance;
        }
    }));

    if (!matchedEvaluators.some(evaluator => evaluator !== undefined)) {
        return [];
    }

    let userItems: (Post | Comment)[] | undefined = options.history;
    if (userItems === undefined) {
        try {
            userItems = await reddit.getCommentsAndPostsByUser({
                username: options.username,
                sort: "new",
                limit: 100,
            }).all();
        } catch {
            // Error retrieving user history, likely shadowbanned.
            return [];
        }
    }

    if (options.targetId && !userItems.some(item => item.id === options.targetId)) {
        if (!silent) {
            console.log(`Evaluator: Adding target item ${options.targetId} to evaluation for ${options.username}`);
        }
        userItems.unshift(await getPostOrCommentById(options.targetId));
    }

    const socialLinks = await getSocialLinksWithCache(user.username);
    const openAIEvaluationKey = await settings.get<string>(AppSetting.OpenAIEvaluationKey);

    await Promise.all(_.compact(matchedEvaluators).map(async (evaluator) => {
        if (evaluator.needsOpenAiKey && openAIEvaluationKey) {
            evaluator.setOpenAiKey(openAIEvaluationKey);
        }

        evaluator.setHistory(userItems);
        evaluator.setSocialLinks(socialLinks);
        let isABot: boolean;
        try {
            isABot = await Promise.resolve(evaluator.evaluate(user));
        } catch (error) {
            console.error(`Evaluator: ${options.username} threw an error during evaluation of ${evaluator.name}: ${error}`);
            if (options.throwOnError) {
                throw error;
            }
            return;
        }
        if (isABot) {
            if (!silent) {
                console.log(`Evaluator: ${options.username} appears to be a bot via the evaluator: ${evaluator.name} 💥`);
            }
            if (evaluator.name.includes("Bot Group") && evaluator.hitReasons && evaluator.hitReasons.length > 0) {
                if (!silent) {
                    const reasons = normaliseHitReasons(evaluator.hitReasons);
                    console.log(`Evaluator: Hit reasons: ${reasons.map(item => item.reason).join(", ")}`);
                }
            }
            detectedBots.push(evaluator);
        }
    }));

    if (detectedBots.length === 0) {
        return [];
    }

    const itemCount = userItems.length;

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

function getEvaluationResultText (result: EvaluationResult): string {
    let text = result.botName;
    if (result.botName.includes("Bot Group") && result.hitReason) {
        if (typeof result.hitReason === "string") {
            text += `(${result.hitReason})`;
        } else {
            text += `: ${result.hitReason.reason}`;
        }
    }
    return text;
}

export async function handleControlSubAccountEvaluation (request: TaskRequest<EvaluateUserJobData>) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (controlSubSettings.evaluationDisabled) {
        console.log("Control Sub Account Evaluation: Evaluation is disabled in settings.");
        return;
    }

    if (await hasEventBeenHandled(`job:${request.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Control Sub Account Evaluation: Job with guid ${request.data.jobGuid} has already been handled, skipping.`);
        return;
    }

    const username = request.data.username;
    const postId = request.data.postId;
    const forceManualReview = request.data.forceManualReview;
    const forceManualReviewReasons = request.data.forceManualReviewReasons;

    const variables = await getEvaluatorVariables();
    const evaluationResults = await evaluateUserAccount({
        username,
        variables,
    });

    const evaluationResultsToStore = evaluationResults.filter(result => result.canAutoBan);
    await storeAccountInitialEvaluationResults(username, evaluationResultsToStore);

    const currentStatus = await getUserStatus(username);
    if (currentStatus && currentStatus.userStatus !== UserStatus.Pending) {
        console.log(`Evaluation: ${username} has already been classified`);
        return;
    }

    if (evaluationResults.length === 0 && currentStatus?.submitter && !await accountIsBotBouncerApp(currentStatus.submitter)) {
        const history = await reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            limit: 100,
        }).all();

        const evaluator = new EvaluateBotGroupAdvancedSubmitters(history, undefined, variables);
        if (!evaluator.evaluatorDisabled()) {
            evaluator.setSubmitterName(currentStatus.submitter);
            const user = await getUserExtended(username);
            if (user) {
                const isABot = await evaluator.evaluate(user);
                if (isABot) {
                    console.log(`Evaluator: ${username} was submitted by ${currentStatus.submitter} and matches a group`);
                    await reddit.setPostFlair({
                        subredditName: CONTROL_SUBREDDIT,
                        postId,
                        flairTemplateId: PostFlairTemplate.Banned,
                    });
                    return;
                }
            }
        }
    }

    let reportReason: string | undefined;

    if (evaluationResults.length === 0) {
        reportReason = "Needs manual review.";
    } else if (evaluationResults.every(result => !result.metThreshold)) {
        reportReason = `Possible bot via evaluation, but insufficient content: ${evaluationResults.map(getEvaluationResultText).join(", ")}`;
    } else if (!evaluationResults.some(result => result.canAutoBan)) {
        reportReason = `Possible bot via evaluation, tagged as no-auto-ban: ${evaluationResults.map(getEvaluationResultText).join(", ")}`;
    } else if (forceManualReview && evaluationResults.length > 0) {
        reportReason = `Likely bot via evaluation, needs manual check: ${evaluationResults.map(getEvaluationResultText).join(", ")}`;
        if (forceManualReviewReasons && forceManualReviewReasons.length > 0) {
            reportReason += `. Additional reasons: ${forceManualReviewReasons.join(", ")}`;
        }
    } else if (await userHasContinuousNSFWHistory(username)) {
        reportReason = "Possible bot via evaluation, but continuous NSFW history detected.";
    }

    if (reportReason) {
        if (currentStatus?.submitter && !await accountIsBotBouncerApp(currentStatus.submitter)) {
            reportReason += ` Submitted by ${currentStatus.submitter}`;
            const submitterSuccessRate = await getSubmitterSuccessRate(currentStatus.submitter);
            if (submitterSuccessRate !== undefined) {
                reportReason += ` (${submitterSuccessRate}%)`;
            }
        }
        const post = await reddit.getPostById(postId);
        await reddit.report(post, { reason: reportReason.trim().substring(0, 99) }); // Reddit's API limits report reasons to 100 characters.
        if (!request.data.skipSummary) {
            await createUserSummary(username, postId);
            const controlSubSettings = await getControlSubSettings();
            if (controlSubSettings.createAISummaryOnNewPosts) {
                await scheduler.runJob<OpenAISummaryGatherData>({
                    name: ControlSubredditJob.OpenAISummaryGather,
                    data: {
                        username,
                        mode: "auto",
                        postId,
                        jobGuid: crypto.randomUUID(),
                    },
                    runAt: addSeconds(new Date(), 50),
                });
            }
        }
        return;
    }

    await reddit.setPostFlair({
        subredditName: CONTROL_SUBREDDIT,
        postId,
        flairTemplateId: PostFlairTemplate.Banned,
    });

    console.log(`Evaluator: Post flair changed for ${username}`);
}

function getEvaluationResultsKey (username: string): string {
    return `evaluationResults:${username}`;
}

function truncatedHitReason (hitReason?: HitReason): HitReasonDetailed | undefined {
    if (!hitReason) {
        return;
    }
    const normalised = normaliseHitReason(hitReason);
    return {
        reason: normalised.reason.length > 500 ? `${normalised.reason.substring(0, 500)}...` : normalised.reason,
        details: normalised.details.map(detail => ({
            key: detail.key,
            value: detail.value.length > 500 ? `${detail.value.substring(0, 500)}...` : detail.value,
        })),
    };
}

export async function storeAccountInitialEvaluationResults (username: string, results: EvaluationResult[]) {
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
    const newData = conditionallyCompressString(JSON.stringify(resultsToStore));
    await redis.set(resultsKey, newData);

    return newData.length;
}

export async function getAccountInitialEvaluationResults (username: string): Promise<EvaluationResult[]> {
    const results = await redis.get(getEvaluationResultsKey(username));

    if (!results) {
        return [];
    }

    return JSON.parse(conditionallyDecompressString(results)) as EvaluationResult[];
}

export async function deleteAccountInitialEvaluationResults (username: string) {
    await redis.del(getEvaluationResultsKey(username));
}

async function subIsNSFW (subredditName: string): Promise<boolean> {
    const redisKey = `isSubNSFW:${subredditName}`;
    const cachedValue = await redis.get(redisKey);
    if (cachedValue) {
        return JSON.parse(cachedValue) as boolean;
    }

    let subredditInfo: SubredditInfo | undefined;
    try {
        subredditInfo = await reddit.getSubredditInfoByName(subredditName);
    } catch {
        // Error retrieving subreddit info, likely gated or freshly banned.
    }

    const isNSFW = subredditInfo?.isNsfw ?? false;

    await redis.set(redisKey, JSON.stringify(isNSFW), { expiration: addWeeks(new Date(), 1) });
    console.log(`Subreddit ${subredditName} is NSFW: ${isNSFW}`);
    return isNSFW;
}

export async function userHasContinuousNSFWHistory (username: string): Promise<boolean> {
    let posts = await reddit.getPostsByUser({
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
            subNSFW[subreddit] ??= await subIsNSFW(subreddit);
            if (subNSFW[subreddit]) {
                continue;
            }
        }

        // If we have a month with no NSFW posts and no NSFW subreddits, return false.
        return false;
    }

    return true;
}
