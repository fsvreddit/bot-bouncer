import { Comment, JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { median } from "../utility.js";
import { addMilliseconds, differenceInDays, differenceInHours, differenceInMilliseconds, differenceInMinutes, Duration, format, formatDuration, intervalToDuration, startOfDecade } from "date-fns";
import _ from "lodash";
import { count } from "@wordpress/wordcount";
import { isUserPotentiallyBlockingBot } from "./blockChecker.js";
import pluralize from "pluralize";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserExtended, UserExtended } from "../extendedDevvit.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import markdownEscape from "markdown-escape";
import { ALL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";
import { BIO_TEXT_STORE, getUserStatus } from "../dataStore.js";
import { getUserSocialLinks } from "devvit-helpers";
import { getSubmitterSuccessRate } from "../statistics/submitterStatistics.js";
import { getSummaryExtras } from "./summaryExtras.js";

function formatDifferenceInDates (start: Date, end: Date) {
    const units: (keyof Duration)[] = ["years", "months", "days"];
    if (differenceInDays(end, start) < 2) {
        units.push("hours");
    }
    if (differenceInHours(end, start) < 6) {
        units.push("minutes");
    }
    if (differenceInMinutes(end, start) < 4) {
        units.push("seconds");
    }

    const duration = intervalToDuration({ start, end });
    return formatDuration(duration, { format: units });
}

function timeBetween (history: (Post | Comment)[], type: "min" | "max" | "10th") {
    if (history.length < 2) {
        return;
    }

    const diffs: number[] = [];

    for (let i = 0; i < history.length - 1; i++) {
        const first = history[i];
        const second = history[i + 1];
        diffs.push(differenceInMilliseconds(first.createdAt, second.createdAt));
    }

    if (diffs.length === 0) {
        return undefined;
    }

    // Order diffs from smallest to largest
    diffs.sort((a, b) => a - b);
    let diff: number;

    if (type === "min") {
        diff = diffs[0];
    } else if (type === "max") {
        diff = diffs[diffs.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (type === "10th") {
        const tenthIndex = Math.floor(diffs.length * 0.1);
        diff = diffs[tenthIndex];
    } else {
        return;
    }

    const start = startOfDecade(new Date());
    const end = addMilliseconds(start, diff);

    return formatDifferenceInDates(start, end);
}

function averageInterval (history: (Post | Comment)[], mode: "mean" | "median") {
    if (history.length < 2) {
        return;
    }

    const differences: number[] = [];

    for (let i = 0; i < history.length - 1; i++) {
        const first = history[i];
        const second = history[i + 1];
        differences.push(differenceInMilliseconds(first.createdAt, second.createdAt));
    }

    const start = startOfDecade(new Date());
    const end = addMilliseconds(start, Math.round(mode === "mean" ? _.mean(differences) : median(differences)));

    return formatDifferenceInDates(start, end);
}

function minMaxAvg (numbers: number[]) {
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const avg = Math.round(_.mean(numbers));
    const mdn = Math.round(median(numbers));

    if (min === max) {
        return `All ${min.toLocaleString()}`;
    }

    return `Min: ${min.toLocaleString()}, `
        + `Max: ${max.toLocaleString()}, `
        + `Average: ${avg.toLocaleString()}, `
        + `Median: ${mdn.toLocaleString()}`;
}

function numberToBlock (input: number): string {
    switch (input) {
        case 0: return "";
        case 1: return "▁";
        case 2: return "▂";
        case 3: return "▃";
        case 4: return "▄";
        case 5: return "▅";
        case 6: return "▆";
        case 7: return "▇";
        case 8: return "█";
        default: throw new Error("Number out of range");
    }
}

function activityByTimeOfDay (history: (Post | Comment)[]): json2md.DataObject[] {
    const hours = _.countBy(history.map(item => item.createdAt.getHours()));
    const max = Math.max(...Object.values(hours));

    const headers: string[] = [];
    const values: string[] = [];

    for (let i = 0; i < 24; i++) {
        const value = hours[i] || 0;
        const blockHeight = Math.round(8 * value / max);
        headers.push(i.toString());
        values.push(numberToBlock(blockHeight));
    }

    const result: json2md.DataObject[] = [
        { h2: "Activity by time of day" },
        { table: { headers, rows: [values] } },
    ];

    return result;
}

function cleanedBio (bio: string, bannedDomains: string[]): string {
    let result = bio;
    for (const domain of bannedDomains) {
        result = result.replaceAll(domain, "[redacted]");
    }
    return result;
}

function getCommonEntriesForContent (items: Post[] | Comment[]): string[] {
    const kind = items[0] instanceof Post ? "post" : "comment";

    const bullets: string[] = [];
    if (items.length > 2) {
        bullets.push(`Min time between ${kind}s: ${timeBetween(items, "min")}`);
        bullets.push(`10th percentile time between ${kind}s: ${timeBetween(items, "10th")}`);
        bullets.push(`Max time between ${kind}s: ${timeBetween(items, "max")}`);
        bullets.push(`Average time between ${kind}s: ${averageInterval(items, "mean")} (median: ${averageInterval(items, "median")})`);
    } else if (items.length === 2) {
        bullets.push(`Time between ${kind}s: ${timeBetween(items, "min")}`);
    }

    return bullets;
}

export function evaluationResultsToBullets (results: EvaluationResult[]) {
    const markdown: json2md.DataObject[] = [];

    for (const result of results) {
        let row = `**${result.botName}** matched`;
        if (result.hitReason) {
            let reasonToStore: string;
            if (typeof result.hitReason === "string") {
                reasonToStore = result.hitReason;
            } else {
                reasonToStore = result.hitReason.reason;
            }
            row += `: ${reasonToStore.length > 500 ? `${reasonToStore.substring(0, 500)}...` : reasonToStore}`;
        }
        markdown.push({ p: row });

        if (typeof result.hitReason === "object") {
            const detailRows: string[] = [];
            for (const detail of result.hitReason.details) {
                detailRows.push(`${detail.key}: ${detail.value.length > 500 ? `${detail.value.substring(0, 500)}...` : detail.value}`);
            }
            markdown.push({ ul: detailRows });
        }
    }
    return markdown;
}

export async function getSummaryForUser (username: string, source: "modmail" | "submission", context: TriggerContext): Promise<json2md.DataObject[]> {
    const userStatus = await getUserStatus(username, context);
    const summary: json2md.DataObject[] = [];

    if (userStatus && (source === "modmail")) {
        const post = await context.reddit.getPostById(userStatus.trackingPostId);

        let firstLine = `/u/${username} is currently listed as ${userStatus.userStatus}, set by ${userStatus.operator} at ${new Date(userStatus.lastUpdate).toUTCString()}`;
        if (userStatus.submitter) {
            firstLine += ` and reported by ${userStatus.submitter}`;
            const successRate = await getSubmitterSuccessRate(userStatus.submitter, context);
            if (successRate !== undefined) {
                firstLine += ` (${successRate}%)`;
            }
        }

        summary.push(
            { p: firstLine },
            { p: `[Link to submission](https://www.reddit.com${post.permalink}) | [Pushshift](https://shiruken.github.io/chearch/?kind=comment&author=${username}&limit=100) | [Arctic Shift](https://arctic-shift.photon-reddit.com/search?fun=posts_search&author=${username}&limit=50&sort=desc)` },
        );
    }

    const extendedUser = await getUserExtended(username, context);

    if (!extendedUser) {
        summary.push({ p: `User Summary: User ${username} is already shadowbanned or suspended, so summary will not be created.` });
        return summary;
    }

    console.log(`User Summary: Creating summary for ${username}`);

    const evaluatorVariables = await getEvaluatorVariables(context);

    const accountAge = formatDifferenceInDates(extendedUser.createdAt, new Date());

    summary.push({ h2: `Account Properties` });

    const accountPropsBullets = [
        `Account age: ${accountAge}`,
        `Comment karma: ${extendedUser.commentKarma.toLocaleString()}`,
        `Post karma: ${extendedUser.linkKarma.toLocaleString()}`,
        `Verified Email: ${extendedUser.hasVerifiedEmail ? "Yes" : "No"}`,
        `Subreddit Moderator: ${extendedUser.isModerator ? "Yes" : "No"}`,
    ];

    if (userStatus?.flags && userStatus.flags.length > 0) {
        accountPropsBullets.push(`Account flags: ${userStatus.flags.join(", ")}`);
    }

    const socialLinks = await getUserSocialLinks(username, context.metadata);
    const uniqueSocialLinks = _.compact(_.uniq(socialLinks.map(link => link.outboundUrl)));
    if (uniqueSocialLinks.length > 0) {
        if (source === "modmail") {
            accountPropsBullets.push(`Social links: ${uniqueSocialLinks.join(", ")}`);
        } else {
            accountPropsBullets.push(`Social links: ${uniqueSocialLinks.length}`);
        }
    }

    const userHasGold = extendedUser.isGold;
    if (userHasGold) {
        accountPropsBullets.push("User has Reddit Premium");
    }

    const userDisplayName = extendedUser.displayName;
    if (userDisplayName) {
        accountPropsBullets.push(`Display name: ${userDisplayName}`);
    }

    const userBio = extendedUser.userDescription;
    const sitewideBannedDomains = evaluatorVariables["generic:sitewidebanneddomains"] as string[] | undefined ?? [];

    if (userBio?.includes("\n")) {
        summary.push({ ul: accountPropsBullets });
        summary.push({ blockquote: cleanedBio(userBio, sitewideBannedDomains) });
    } else if (userBio) {
        accountPropsBullets.push(`Bio: ${cleanedBio(userBio, sitewideBannedDomains)}`);
        summary.push({ ul: accountPropsBullets });
    } else {
        summary.push({ ul: accountPropsBullets });
    }

    if (source === "modmail") {
        const originalBio = await context.redis.hGet(BIO_TEXT_STORE, username);
        if (originalBio && originalBio.trim() !== userBio?.trim()) {
            if (userBio?.includes("\n")) {
                summary.push({ p: "Original bio:" });
                summary.push({ blockquote: cleanedBio(originalBio, sitewideBannedDomains) });
            } else {
                summary.push({ p: `Original bio: ${cleanedBio(originalBio, sitewideBannedDomains)}` });
            }
        }
    }

    let userComments: Comment[];
    let userPosts: Post[];

    try {
        [userComments, userPosts] = await Promise.all([
            context.reddit.getCommentsByUser({
                username,
                sort: "new",
                limit: 100,
            }).all(),
            context.reddit.getPostsByUser({
                username,
                sort: "new",
                limit: 100,
            }).all(),
        ]);
    } catch {
        if (source === "modmail") {
            const initialEvaluatorsMatched = await getAccountInitialEvaluationResults(username, context);
            summary.push({ p: `At the point of initial evaluation, user matched ${initialEvaluatorsMatched.length} ${pluralize("evaluator", initialEvaluatorsMatched.length)}` });

            summary.push(...evaluationResultsToBullets(initialEvaluatorsMatched));
        }

        summary.push({ h2: "User Activity" });
        summary.push({ p: "An error occurred when fetching user activity. This may be due to the user being shadowbanned or suspended, or due to a Reddit bug that prevents some posts from being retrieved by the Dev Platform." });
        return summary;
    }

    const potentiallyBlocking = await isUserPotentiallyBlockingBot([...userComments, ...userPosts], context);
    if (potentiallyBlocking) {
        accountPropsBullets.push("User is potentially blocking bot u/bot-bouncer (their visible history only shows subs where app is installed)");
    } else {
        accountPropsBullets.push("User is not blocking u/bot-bouncer");
    }

    if (source === "modmail") {
        const initialEvaluatorsMatched = await getAccountInitialEvaluationResults(username, context);
        const matchedEvaluators = await evaluatorsMatched(extendedUser, [...userComments, ...userPosts], evaluatorVariables, context);
        if (matchedEvaluators.length > 0 || initialEvaluatorsMatched.length > 0) {
            summary.push({ h2: "Evaluation results" });
        }

        if (initialEvaluatorsMatched.length > 0) {
            summary.push({ p: `At the point of initial evaluation, user matched ${initialEvaluatorsMatched.length} ${pluralize("evaluator", initialEvaluatorsMatched.length)}` });

            summary.push(...evaluationResultsToBullets(initialEvaluatorsMatched));
        }

        if (matchedEvaluators.length > 0) {
            summary.push({ p: `User currently matches ${matchedEvaluators.length} ${pluralize("evaluator", matchedEvaluators.length)}` });

            const evaluationResults: EvaluationResult[] = [];

            for (const evaluator of matchedEvaluators) {
                if (!evaluator.hitReasons || evaluator.hitReasons.length === 0) {
                    evaluationResults.push({
                        botName: evaluator.name,
                        canAutoBan: evaluator.canAutoBan,
                        metThreshold: true,
                    });
                } else {
                    for (const hitReason of evaluator.hitReasons) {
                        evaluationResults.push({
                            botName: evaluator.name,
                            hitReason,
                            canAutoBan: evaluator.canAutoBan,
                            metThreshold: true,
                        });
                    }
                }
            }

            summary.push(...evaluationResultsToBullets(evaluationResults));
        }
    }

    try {
        const allModNotes = await context.reddit.getModNotes({
            user: username,
            limit: 100,
            subreddit: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
            filter: "NOTE",
        }).all();

        const relevantModNotes = allModNotes.filter(note => note.userNote?.note && note.operator.name && note.operator.name !== context.appName);

        if (relevantModNotes.length > 0) {
            summary.push({ h2: "Mod Notes" });
            for (const note of relevantModNotes) {
                summary.push({ p: `**${markdownEscape(note.operator.name ?? "unknown")}** on ${format(note.createdAt, "yyyy-MM-dd")}` });
                summary.push({ blockquote: note.userNote?.note ?? "" });
            }
        }
    } catch {
        // This seems to fail a fair bit. Just ignore it if mod notes don't load.
    }

    const extras = getSummaryExtras(evaluatorVariables);

    if (userComments.length > 0) {
        summary.push({ h2: "Comments" });
        summary.push({ p: `User has ${userComments.length} ${pluralize("comment", userComments.length)}` });

        const bullets = getCommonEntriesForContent(userComments);

        bullets.push(`Length: ${minMaxAvg(userComments.map(comment => comment.body.length))}`);
        bullets.push(`Word count: ${minMaxAvg(userComments.map(comment => count(comment.body, "words", {})))}`);
        bullets.push(`Paragraphs: ${minMaxAvg(userComments.map(comment => comment.body.split("\n\n").length))}`);

        const commentsExtras = extras.filter(extra => extra.type === "comment");
        for (const extra of commentsExtras) {
            const regex = new RegExp(extra.regex, "u");
            const matchCount = userComments.filter(comment => regex.test(comment.body)).length;
            if (matchCount > 0) {
                bullets.push(`${extra.title}: ${matchCount} (${Math.round(100 * matchCount / userComments.length)}%)`);
            }
        }

        const topLevelPercentage = Math.floor(100 * userComments.filter(comment => isLinkId(comment.parentId)).length / userComments.length);
        bullets.push(`Top level comments: ${topLevelPercentage}% of total`);

        const editedCommentPercentage = Math.round(100 * userComments.filter(comment => comment.edited).length / userComments.length);
        if (editedCommentPercentage > 0) {
            bullets.push(`Edited comments: ${editedCommentPercentage}% of total`);
        }

        const subreddits = _.countBy(_.compact(userComments.map(comment => comment.subredditName)));
        bullets.push(`Comment subreddits: ${Object.entries(subreddits).map(([subreddit, count]) => `${markdownEscape(subreddit)}: ${count}`).join(", ")}`);

        const commentsPerPost = _.countBy(Object.values(_.countBy(userComments.map(comment => comment.postId))));
        bullets.push(`Comments per post: ${Object.entries(commentsPerPost).map(([count, posts]) => `${count} comments: ${posts}`).join(", ")}`);

        if (userComments.length < 90) {
            bullets.push(`First comment was ${formatDifferenceInDates(extendedUser.createdAt, userComments[userComments.length - 1].createdAt)} after account creation`);
        }

        summary.push({ ul: bullets });
    }

    if (userPosts.length > 0) {
        summary.push({ h2: "Posts" });
        summary.push({ p: `User has ${userPosts.length} ${pluralize("post", userPosts.length)}` });

        const nonStickied = userPosts
            .filter(post => !post.stickied)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        const bullets = getCommonEntriesForContent(nonStickied);

        const editedPostPercentage = Math.round(100 * userPosts.filter(post => post.edited).length / userPosts.length);
        if (editedPostPercentage > 0) {
            bullets.push(`Edited posts: ${editedPostPercentage}% of total`);
        }

        const postsExtras = extras.filter(extra => extra.type === "post");
        for (const extra of postsExtras) {
            const regex = new RegExp(extra.regex, "u");
            const matchCount = userPosts.filter(post => post.body && regex.test(post.body)).length;
            if (matchCount > 0) {
                bullets.push(`${extra.title}: ${matchCount} (${Math.round(100 * matchCount / userPosts.length)}%)`);
            }
        }

        const subreddits = _.countBy(_.compact(userPosts.map(post => post.subredditName)));
        bullets.push(`Post subreddits: ${Object.entries(subreddits).map(([subreddit, count]) => `${markdownEscape(subreddit)}: ${count}`).join(", ")}`);
        if (userPosts.length < 90) {
            bullets.push(`First post was ${formatDifferenceInDates(extendedUser.createdAt, userPosts[userPosts.length - 1].createdAt)} after account creation`);
        }

        summary.push({ ul: bullets });
    }

    if (userComments.length > 0 || userPosts.length > 0) {
        summary.push(activityByTimeOfDay([...userComments, ...userPosts]));
    } else {
        summary.push({ h2: "Activity" });
        summary.push({ p: "User has no comments or posts visible on their profile" });
    }

    return summary;
}

export async function createUserSummary (username: string, postId: string, context: TriggerContext) {
    const summary = await getSummaryForUser(username, "submission", context);

    const newComment = await context.reddit.submitComment({
        id: postId,
        text: json2md(summary),
    });
    await newComment.remove();

    console.log(`User Summary: Summary created for ${username}`);
}

async function evaluatorsMatched (user: UserExtended, userHistory: (Post | Comment)[], evaluatorVariables: Record<string, JSONValue>, context: TriggerContext): Promise<InstanceType<typeof ALL_EVALUATORS[number]>[]> {
    const evaluatorsMatched: InstanceType<typeof ALL_EVALUATORS[number]>[] = [];

    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, undefined, evaluatorVariables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        const userEvaluate = await Promise.resolve(evaluator.preEvaluateUser(user));
        if (!userEvaluate) {
            continue;
        }

        const fullEvaluate = await Promise.resolve(evaluator.evaluate(user, userHistory));
        if (fullEvaluate) {
            evaluatorsMatched.push(evaluator);
        }
    }

    return evaluatorsMatched;
}
