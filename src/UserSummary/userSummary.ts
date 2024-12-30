import { Comment, JobContext, JSONObject, Post, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { domainFromUrl, getUserOrUndefined } from "../utility.js";
import { addMilliseconds, differenceInDays, differenceInHours, differenceInMilliseconds, differenceInMinutes, Duration, formatDuration, intervalToDuration, startOfDecade } from "date-fns";
import { autogenRegex, femaleNameRegex, resemblesAutogen } from "./regexes.js";
import { compact, countBy, mean } from "lodash";
import { count } from "@wordpress/wordcount";
import { isUserPotentiallyBlockingBot } from "./blockChecker.js";
import pluralize from "pluralize";
import { isLinkId } from "@devvit/shared-types/tid.js";

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

function timeBetween (history: (Post | Comment)[], type: "min" | "max") {
    if (history.length < 2) {
        return;
    }

    let diff: number | undefined;

    for (let i = 0; i < history.length - 1; i++) {
        const first = history[i];
        const second = history[i + 1];
        const thisDiff = differenceInMilliseconds(first.createdAt, second.createdAt);
        if (!diff || (type === "min" && thisDiff < diff) || (type === "max" && thisDiff > diff)) {
            diff = thisDiff;
        }
    }

    if (diff === undefined) {
        return;
    }

    const start = startOfDecade(new Date());
    const end = addMilliseconds(start, diff);

    return formatDifferenceInDates(start, end);
}

function averageInterval (history: (Post | Comment)[]) {
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
    const end = addMilliseconds(start, Math.round(mean(differences)));

    return formatDifferenceInDates(start, end);
}

function minMaxAvg (numbers: number[]) {
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const avg = Math.round(mean(numbers));

    if (min === max) {
        return `All ${min.toLocaleString()}`;
    }

    return `Min: ${min.toLocaleString()}, `
        + `Max: ${max.toLocaleString()}, `
        + `Average: ${avg.toLocaleString()}`;
}

function femaleNameCheck (username: string) {
    const matches = femaleNameRegex.exec(username);
    if (matches && matches.length === 2) {
        const [, name] = matches;
        return `* Username includes a female name (${name}), a common trait of bot accounts\n`;
    }

    // Now repeat the checks, taking out doubled-up letters one by one
    for (let i = 0; i < username.length - 1; i++) {
        if (username[i] !== username[i + 1]) {
            continue;
        }
        const newUsername = username.slice(0, i) + username.slice(i + 1);
        const newMatches = femaleNameRegex.exec(newUsername);
        if (newMatches && newMatches.length === 2) {
            const [, name] = newMatches;
            return `* Username includes a female name (${name}) with a doubled up letter, a common trait of bot accounts\n`;
        }
    }
}

export async function createUserSummary (username: string, postId: string, context: TriggerContext) {
    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return;
    }

    console.log(`User Summary: Creating summary for ${username}`);

    const accountAge = formatDifferenceInDates(user.createdAt, new Date());

    let summary = "## Account Properties\n\n";
    summary += `* Account age: ${accountAge}\n`;
    summary += `* Comment karma: ${user.commentKarma}\n`;
    summary += `* Post karma: ${user.linkKarma}\n`;

    const socialLinks = await user.getSocialLinks();
    summary += `* Social links: ${socialLinks.length}\n`;

    if (autogenRegex.test(user.username)) {
        summary += "* Username matches autogen pattern\n";
    } else if (resemblesAutogen.test(user.username)) {
        summary += "* Username resembles autogen pattern, but uses different keywords\n";
    }

    const femaleNameSummaryLine = femaleNameCheck(user.username);
    if (femaleNameSummaryLine) {
        summary += femaleNameSummaryLine;
    }

    const userComments = await context.reddit.getCommentsByUser({
        username,
        sort: "new",
        limit: 100,
    }).all();

    const userPosts = await context.reddit.getPostsByUser({
        username,
        sort: "new",
        limit: 100,
    }).all();

    const potentiallyBlocking = await isUserPotentiallyBlockingBot([...userComments, ...userPosts], context);
    if (potentiallyBlocking) {
        summary += "* User is potentially blocking bot u/bot-bouncer (their visible history only shows subs where app is installed)\n";
    } else {
        summary += "* User is not blocking u/bot-bouncer\n";
    }

    summary += "\n";

    if (userComments.length > 0) {
        summary += "## Comments\n\n";
        summary += `User has ${userComments.length} ${pluralize("comment", userComments.length)}\n\n`;
        if (userComments.length > 2) {
            summary += `* Min time between comments: ${timeBetween(userComments, "min")}\n`;
            summary += `* Max time between comments: ${timeBetween(userComments, "max")}\n`;
            summary += `* Average time between comments: ${averageInterval(userComments)}\n`;
        }
        summary += `* Length: ${minMaxAvg(userComments.map(comment => comment.body.length))}\n`;
        summary += `* Word count: ${minMaxAvg(userComments.map(comment => count(comment.body, "words", {})))}\n`;
        summary += `* Paragraphs: ${minMaxAvg(userComments.map(comment => comment.body.split("\n\n").length))}\n`;
        summary += `* Comments with em-dashes: ${Math.round(100 * userComments.filter(comment => comment.body.includes("—")).length / userComments.length)}%\n`;
        const topLevelPercentage = Math.floor(100 * userComments.filter(comment => isLinkId(comment.parentId)).length / userComments.length);
        summary += `* Top level comments: ${topLevelPercentage}% of total\n`;

        const subreddits = countBy(compact(userComments.map(comment => comment.subredditName)));
        summary += `* Comment subreddits: ${Object.entries(subreddits).map(([subreddit, count]) => `r/${subreddit}: ${count}`).join(", ")}\n`;

        if (userComments.length < 90) {
            summary += `* First comment was ${formatDifferenceInDates(user.createdAt, userComments[userComments.length - 1].createdAt)} after account creation\n`;
        }
    }

    summary += "\n";

    if (userPosts.length > 0) {
        summary += "## Posts\n\n";
        summary += `User has ${userPosts.length} ${pluralize("post", userPosts.length)}\n\n`;
        if (userPosts.length > 2) {
            const nonStickied = userPosts.filter(post => !post.stickied);
            summary += `* Min time between posts: ${timeBetween(nonStickied, "min")}\n`;
            summary += `* Max time between posts: ${timeBetween(nonStickied, "max")}\n`;
            summary += `* Average time between posts: ${averageInterval(nonStickied)}\n`;
        }

        const domains = countBy(compact(userPosts.map(post => domainFromUrl(post.url))));
        if (Object.keys(domains).length > 0) {
            summary += `* Domains: ${Object.entries(domains).map(([domain, count]) => `${domain}: ${count}`).join(", ")}\n`;
        }

        const subreddits = countBy(compact(userPosts.map(post => post.subredditName)));
        summary += `* Post subreddits: ${Object.entries(subreddits).map(([subreddit, count]) => `r/${subreddit}: ${count}`).join(", ")}\n`;
        if (userPosts.length < 90) {
            summary += `* First post was ${formatDifferenceInDates(user.createdAt, userPosts[userPosts.length - 1].createdAt)} after account creation\n`;
        }
    }

    const newComment = await context.reddit.submitComment({
        id: postId,
        text: summary,
    });
    await newComment.remove();

    console.log(`User Summary: Summary created for ${username}`);
}

export async function createUserSummaryJobHandler (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const username = event.data?.username as string | undefined;
    const postId = event.data?.postId as string | undefined;

    if (!username || !postId) {
        return;
    }

    await createUserSummary(username, postId, context);
}
