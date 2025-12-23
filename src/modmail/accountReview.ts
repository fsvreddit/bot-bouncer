import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import json2md from "json2md";
import { getUsernameFromUrl } from "../utility.js";
import pluralize from "pluralize";
import { addDays, addSeconds } from "date-fns";
import { CONTROL_SUBREDDIT } from "../constants.js";

const ACCOUNT_REVIEW_QUEUE = "accountReviewQueue";

function accountReviewKey (postId: string): string {
    return `accountReview:${postId}`;
}

interface AccountReviewData {
    reviewRequestedBy?: string;
    reviewRequestedAt: number;
    reviewReason?: string;
}

export async function submitAccountForReview (postId: string, requestedBy: string, duration: number, reason: string | undefined, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Account reviews can only be submitted from the control subreddit.");
    }

    const reviewData: AccountReviewData = {
        reviewRequestedBy: requestedBy,
        reviewRequestedAt: Date.now(),
        reviewReason: reason,
    };

    await context.redis.set(accountReviewKey(postId), JSON.stringify(reviewData), { expiration: addDays(new Date(), duration + 1) });
    await context.redis.zAdd(ACCOUNT_REVIEW_QUEUE, { member: postId, score: addDays(new Date(), duration).getTime() });
    console.log(`Account Review: Submitted post ${postId} for review by ${requestedBy} in ${duration} ${pluralize("day", duration)}.`);
}

export async function checkAccountsForReview (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Account reviews can only be submitted from the control subreddit.");
    }

    const runLimit = addSeconds(new Date(), 10);

    const accountsToReview = await context.redis.zRange(ACCOUNT_REVIEW_QUEUE, 0, Date.now(), { by: "score" });
    if (accountsToReview.length === 0) {
        console.log("No accounts to review.");
        return;
    }

    const runRecentlyKey = "accountReviewLastRun";
    if (event.data?.firstRun && await context.redis.exists(runRecentlyKey)) {
        return;
    }

    await context.redis.set(runRecentlyKey, "true", { expiration: addSeconds(new Date(), 10) });
    const processedItems: string[] = [];

    while (accountsToReview.length > 0 && new Date() < runLimit) {
        const item = accountsToReview.shift();
        if (!item) {
            break;
        }

        processedItems.push(item.member);

        const post = await context.reddit.getPostById(item.member);
        if (post.authorName === "[deleted]") {
            continue;
        }

        const reviewDataValue = await context.redis.get(accountReviewKey(item.member));
        if (reviewDataValue) {
            const reviewData = JSON.parse(reviewDataValue) as AccountReviewData;
            const message: json2md.DataObject[] = [];
            if (reviewData.reviewRequestedBy) {
                const username = getUsernameFromUrl(post.url);

                message.push({ p: `An account review was requested by /u/${reviewData.reviewRequestedBy ?? "unknown"} for this post: [${post.title}](${post.permalink})` });
                if (reviewData.reviewReason) {
                    message.push({ p: `Reason: ${reviewData.reviewReason}` });
                }

                if (post.flair?.text) {
                    message.push({ p: `Current user status: **${post.flair.text}**` });
                }

                message.push({ p: `[Link to user profile](https://www.reddit.com/user/${username})` });

                const subject = username ? `Account review reminder for /u/${username}` : "Account review reminder";
                await context.reddit.modMail.createModInboxConversation({
                    subject,
                    subredditId: context.subredditId,
                    bodyMarkdown: json2md(message),
                });

                console.log(`Account Review: Sent review reminder for post ${item.member}.`);

                break;
            }
        }
    }

    console.log(`Account Review: Flagged ${accountsToReview.length} ${pluralize("account", accountsToReview.length)} for review.`);
    await context.redis.zRem(ACCOUNT_REVIEW_QUEUE, processedItems);

    if (accountsToReview.length > 0) {
        await context.scheduler.runJob({
            name: "AccountReview",
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        await context.redis.del(runRecentlyKey);
    }
}
