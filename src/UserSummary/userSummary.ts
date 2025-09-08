import { Comment, JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { domainFromUrl, getUserSocialLinks, median, replaceAll } from "../utility.js";
import { addMilliseconds, differenceInDays, differenceInHours, differenceInMilliseconds, differenceInMinutes, Duration, format, formatDuration, intervalToDuration, startOfDecade } from "date-fns";
import { compact, countBy, mean, uniq } from "lodash";
import { count } from "@wordpress/wordcount";
import { isUserPotentiallyBlockingBot } from "./blockChecker.js";
import pluralize from "pluralize";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserExtended, UserExtended } from "../extendedDevvit.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import markdownEscape from "markdown-escape";
import { ALL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";
import { BIO_TEXT_STORE, getUserStatus } from "../dataStore.js";

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
    const end = addMilliseconds(start, Math.round(mode === "mean" ? mean(differences) : median(differences)));

    return formatDifferenceInDates(start, end);
}

function minMaxAvg (numbers: number[]) {
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const avg = Math.round(mean(numbers));
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
    const hours = countBy(history.map(item => item.createdAt.getHours()));
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
        result = replaceAll(result, domain, "[redacted]");
    }
    return result;
}

export async function getSummaryForUser (username: string, source: "modmail" | "submission", context: TriggerContext): Promise<json2md.DataObject[] | undefined> {
    const extendedUser = await getUserExtended(username, context);

    if (!extendedUser) {
        console.log(`User Summary: User ${username} is already shadowbanned or suspended, so summary will not be created.`);
        return;
    }

    console.log(`User Summary: Creating summary for ${username}`);

    const evaluatorVariables = await getEvaluatorVariables(context);

    const accountAge = formatDifferenceInDates(extendedUser.createdAt, new Date());

    const summary: json2md.DataObject[] = [];
    summary.push({ h2: `Account Properties` });

    const accountPropsBullets = [
        `Account age: ${accountAge}`,
        `Comment karma: ${extendedUser.commentKarma.toLocaleString()}`,
        `Post karma: ${extendedUser.linkKarma.toLocaleString()}`,
        `Verified Email: ${extendedUser.hasVerifiedEmail ? "Yes" : "No"}`,
        `Subreddit Moderator: ${extendedUser.isModerator ? "Yes" : "No"}`,
    ];

    const userStatus = await getUserStatus(username, context);
    if (userStatus?.flags && userStatus.flags.length > 0) {
        accountPropsBullets.push(`Account flags: ${userStatus.flags.join(", ")}`);
    }

    const socialLinks = await getUserSocialLinks(username, context);
    const uniqueSocialDomains = compact(uniq(socialLinks.map(link => domainFromUrl(link.outboundUrl))));
    if (uniqueSocialDomains.length > 0) {
        accountPropsBullets.push(`Social links: ${uniqueSocialDomains.length}`);
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

            const hitsRows = initialEvaluatorsMatched.map((evaluator) => {
                let row = `${evaluator.botName} matched`;
                if (evaluator.hitReason) {
                    row += `: ${evaluator.hitReason}`;
                }
                return row;
            });

            summary.push({ ul: hitsRows });
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

            const hitsRows = initialEvaluatorsMatched.map((evaluator) => {
                let row = `${evaluator.botName} matched`;
                if (evaluator.hitReason) {
                    row += `: ${evaluator.hitReason.slice(0, 1000)}`;
                }
                return row;
            });

            summary.push({ ul: hitsRows });
        }

        if (matchedEvaluators.length > 0) {
            summary.push({ p: `User currently matches ${matchedEvaluators.length} ${pluralize("evaluator", matchedEvaluators.length)}` });

            const hitsRows: string[] = [];

            for (const evaluator of matchedEvaluators) {
                if (!evaluator.hitReasons || evaluator.hitReasons.length === 0) {
                    hitsRows.push(`${evaluator.name} matched`);
                } else {
                    for (const hitReason of evaluator.hitReasons) {
                        hitsRows.push(`${evaluator.name} matched: ${hitReason.slice(0, 1000)}`);
                    }
                }
            }

            summary.push({ ul: hitsRows });
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

    if (userComments.length > 0) {
        summary.push({ h2: "Comments" });
        summary.push({ p: `User has ${userComments.length} ${pluralize("comment", userComments.length)}` });

        const bullets: string[] = [];
        if (userComments.length > 2) {
            bullets.push(`Min time between comments: ${timeBetween(userComments, "min")}`);
            bullets.push(`10th percentile time between comments: ${timeBetween(userComments, "10th")}`);
            bullets.push(`Max time between comments: ${timeBetween(userComments, "max")}`);
            bullets.push(`Average time between comments: ${averageInterval(userComments, "mean")} (median: ${averageInterval(userComments, "median")})`);
        } else if (userComments.length === 2) {
            bullets.push(`Time between comments: ${timeBetween(userComments, "min")}`);
        }

        bullets.push(`Length: ${minMaxAvg(userComments.map(comment => comment.body.length))}`);
        bullets.push(`Word count: ${minMaxAvg(userComments.map(comment => count(comment.body, "words", {})))}`);
        bullets.push(`Paragraphs: ${minMaxAvg(userComments.map(comment => comment.body.split("\n\n").length))}`);
        bullets.push(`Comments with em-dashes: ${Math.round(100 * userComments.filter(comment => comment.body.includes("—")).length / userComments.length)}%`);

        const topLevelPercentage = Math.floor(100 * userComments.filter(comment => isLinkId(comment.parentId)).length / userComments.length);
        bullets.push(`Top level comments: ${topLevelPercentage}% of total`);

        const editedCommentPercentage = Math.round(100 * userComments.filter(comment => comment.edited).length / userComments.length);
        if (editedCommentPercentage > 0) {
            bullets.push(`Edited comments: ${editedCommentPercentage}% of total`);
        }

        const subreddits = countBy(compact(userComments.map(comment => comment.subredditName)));
        bullets.push(`Comment subreddits: ${Object.entries(subreddits).map(([subreddit, count]) => `${markdownEscape(subreddit)}: ${count}`).join(", ")}`);

        const commentsPerPost = countBy(Object.values(countBy(userComments.map(comment => comment.postId))));
        bullets.push(`Comments per post: ${Object.entries(commentsPerPost).map(([count, posts]) => `${count} comments: ${posts}`).join(", ")}`);

        if (userComments.length < 90) {
            bullets.push(`First comment was ${formatDifferenceInDates(extendedUser.createdAt, userComments[userComments.length - 1].createdAt)} after account creation`);
        }

        summary.push({ ul: bullets });
    }

    if (userPosts.length > 0) {
        summary.push({ h2: "Posts" });
        summary.push({ p: `User has ${userPosts.length} ${pluralize("post", userPosts.length)}` });
        const bullets: string[] = [];

        const nonStickied = userPosts
            .filter(post => !post.stickied)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        if (userPosts.length > 2) {
            bullets.push(`Min time between posts: ${timeBetween(nonStickied, "min")}`);
            bullets.push(`10th percentile time between posts: ${timeBetween(nonStickied, "10th")}`);
            bullets.push(`Max time between posts: ${timeBetween(nonStickied, "max")}`);
            bullets.push(`Average time between posts: ${averageInterval(nonStickied, "mean")} (median: ${averageInterval(nonStickied, "median")})`);
        } else if (userPosts.length === 2) {
            bullets.push(`Time between posts: ${timeBetween(nonStickied, "min")}`);
        }

        const editedPostPercentage = Math.round(100 * userPosts.filter(post => post.edited).length / userPosts.length);
        if (editedPostPercentage > 0) {
            bullets.push(`Edited posts: ${editedPostPercentage}% of total`);
        }

        const subreddits = countBy(compact(userPosts.map(post => post.subredditName)));
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
    if (!summary) {
        return;
    }

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
