import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { domainFromUrl, getUserOrUndefined, median } from "../utility.js";
import { addMilliseconds, differenceInDays, differenceInHours, differenceInMilliseconds, differenceInMinutes, Duration, formatDuration, intervalToDuration, startOfDecade } from "date-fns";
import { autogenRegex, femaleNameRegex, resemblesAutogen } from "./regexes.js";
import { compact, countBy, mean, uniq } from "lodash";
import { count } from "@wordpress/wordcount";
import { isUserPotentiallyBlockingBot } from "./blockChecker.js";
import pluralize from "pluralize";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { getRawUserData } from "../extendedDevvit.js";

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

function activityByTimeOfDay (history: (Post | Comment)[]) {
    const hours = countBy(history.map(item => item.createdAt.getHours()));
    const max = Math.max(...Object.values(hours));

    const line1 = "0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23";
    const line2 = "-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-";
    let line3 = "";

    for (let i = 0; i < 24; i++) {
        const value = hours[i] || 0;
        const blockHeight = Math.round(8 * value / max);
        line3 += numberToBlock(blockHeight);
        if (i < 23) {
            line3 += "|";
        }
    }

    return `##Activity by time of day:\n\n${line1}\n${line2}\n${line3}\n\n`;
}

export async function getSummaryTextForUser (username: string, context: TriggerContext): Promise<string | undefined> {
    const user = await getUserOrUndefined(username, context);
    if (!user) {
        console.log(`User Summary: User ${username} is already shadowbanned or suspended, so summary will not be created.`);
        return;
    }

    const extendedUser = await getRawUserData(username, context.debug.metadata);

    console.log(`User Summary: Creating summary for ${username}`);

    const accountAge = formatDifferenceInDates(user.createdAt, new Date());

    let summary = "## Account Properties\n\n";
    summary += `* Account age: ${accountAge}\n`;
    summary += `* Comment karma: ${user.commentKarma}\n`;
    summary += `* Post karma: ${user.linkKarma}\n`;
    summary += `* Verified Email: ${extendedUser?.data?.hasVerifiedEmail ? "Yes" : "No"}\n`;

    const socialLinks = await user.getSocialLinks();
    const uniqueSocialDomains = compact(uniq(socialLinks.map(link => domainFromUrl(link.outboundUrl))));
    if (uniqueSocialDomains.length > 0) {
        summary += `* Social links: ${uniqueSocialDomains.join(", ")}\n`;
    }

    if (autogenRegex.test(user.username)) {
        summary += "* Username matches autogen pattern\n";
    } else if (resemblesAutogen.test(user.username)) {
        summary += "* Username resembles autogen pattern, but uses different keywords\n";
    } else {
        const femaleNameSummaryLine = femaleNameCheck(user.username);
        if (femaleNameSummaryLine) {
            summary += femaleNameSummaryLine;
        }
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

    const userHasGold = extendedUser?.data?.isGold;
    if (userHasGold) {
        summary += "* User has Reddit Premium\n";
    }

    const userDisplayName = extendedUser?.data?.subreddit?.title;
    if (userDisplayName) {
        summary += `* Display name: ${userDisplayName}\n`;
    }

    const userBio = extendedUser?.data?.subreddit?.publicDescription?.trim();
    if (userBio) {
        summary += `* Bio:\n\n> ${userBio.split("\n").join("\n> ")}\n`;
    }

    summary += "\n";

    if (userComments.length > 0) {
        summary += "## Comments\n\n";
        summary += `User has ${userComments.length} ${pluralize("comment", userComments.length)}\n\n`;
        if (userComments.length > 2) {
            summary += `* Min time between comments: ${timeBetween(userComments, "min")}\n`;
            summary += `* Max time between comments: ${timeBetween(userComments, "max")}\n`;
            summary += `* Average time between comments: ${averageInterval(userComments, "mean")} (median: ${averageInterval(userComments, "median")})\n`;
        } else if (userComments.length === 2) {
            summary += `* Time between comments: ${timeBetween(userComments, "min")}\n`;
        }
        summary += `* Length: ${minMaxAvg(userComments.map(comment => comment.body.length))}\n`;
        summary += `* Word count: ${minMaxAvg(userComments.map(comment => count(comment.body, "words", {})))}\n`;
        summary += `* Paragraphs: ${minMaxAvg(userComments.map(comment => comment.body.split("\n\n").length))}\n`;
        summary += `* Comments with em-dashes: ${Math.round(100 * userComments.filter(comment => comment.body.includes("—")).length / userComments.length)}%\n`;
        const topLevelPercentage = Math.floor(100 * userComments.filter(comment => isLinkId(comment.parentId)).length / userComments.length);
        summary += `* Top level comments: ${topLevelPercentage}% of total\n`;

        const editedCommentPercentage = Math.round(100 * userComments.filter(comment => comment.edited).length / userComments.length);
        summary += `* Edited comments: ${editedCommentPercentage}% of total\n`;

        const subreddits = countBy(compact(userComments.map(comment => comment.subredditName)));
        summary += `* Comment subreddits: ${Object.entries(subreddits).map(([subreddit, count]) => `r/${subreddit}: ${count}`).join(", ")}\n`;

        const commentsPerPost = countBy(Object.values(countBy(userComments.map(comment => comment.postId))));
        summary += `* Comments per post: ${Object.entries(commentsPerPost).map(([count, posts]) => `${count} comments: ${posts}`).join(", ")}\n`;

        if (userComments.length < 90) {
            summary += `* First comment was ${formatDifferenceInDates(user.createdAt, userComments[userComments.length - 1].createdAt)} after account creation\n`;
        }
    }

    summary += "\n";

    if (userPosts.length > 0) {
        summary += "## Posts\n\n";
        summary += `User has ${userPosts.length} ${pluralize("post", userPosts.length)}\n\n`;
        const nonStickied = userPosts
            .filter(post => !post.stickied)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        if (userPosts.length > 2) {
            summary += `* Min time between posts: ${timeBetween(nonStickied, "min")}\n`;
            summary += `* Max time between posts: ${timeBetween(nonStickied, "max")}\n`;
            summary += `* Average time between posts: ${averageInterval(nonStickied, "mean")} (median: ${averageInterval(nonStickied, "median")})\n`;
        } else if (userPosts.length === 2) {
            summary += `* Time between posts: ${timeBetween(nonStickied, "min")}\n`;
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

    summary += "\n";

    if (userComments.length > 0 || userPosts.length > 0) {
        summary += activityByTimeOfDay([...userComments, ...userPosts]);
    } else {
        summary += "## Activity\n\n";
        summary += "User has no comments or posts visible on their profile\n\n";
    }

    return summary;
}

export async function createUserSummary (username: string, postId: string, context: TriggerContext) {
    const summary = await getSummaryTextForUser(username, context);
    if (!summary) {
        return;
    }

    const newComment = await context.reddit.submitComment({
        id: postId,
        text: summary,
    });
    await newComment.remove();

    console.log(`User Summary: Summary created for ${username}`);
}
