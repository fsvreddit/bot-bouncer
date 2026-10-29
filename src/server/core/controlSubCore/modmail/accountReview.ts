import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { getUserOrUndefined, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { CONTROL_SUBREDDIT, ControlSubredditJob, getControlSubSettings, getUsernameFromUrl } from "../..";
import { addDays, addMinutes, addSeconds } from "date-fns";
import json2md from "json2md";
import pluralize from "pluralize";
import { T3 } from "@devvit/web/shared";
import { AccountReviewJobData } from "../../../tasks";

const ACCOUNT_REVIEW_QUEUE = "accountReviewQueue";

function accountReviewKey (postId: string): string {
    return `accountReview:${postId}`;
}

export interface AccountReviewRequest {
    postId: T3;
    reviewRequestedBy?: string;
    duration: number;
    reviewReason?: string;
}

interface AccountReviewData {
    reviewRequestedBy?: string;
    reviewRequestedAt: number;
    reviewReason?: string;
}

export async function submitAccountForReview (opts: AccountReviewRequest) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Account reviews can only be submitted from the control subreddit.");
    }

    const reviewData: AccountReviewData = {
        reviewRequestedBy: opts.reviewRequestedBy,
        reviewRequestedAt: Date.now(),
        reviewReason: opts.reviewReason,
    };

    await redis.set(accountReviewKey(opts.postId), JSON.stringify(reviewData), { expiration: addDays(new Date(), opts.duration + 1) });
    await redis.zAdd(ACCOUNT_REVIEW_QUEUE, { member: opts.postId, score: addDays(new Date(), opts.duration).getTime() });
    console.log(`Account Review: Submitted post ${opts.postId} for review by ${opts.reviewRequestedBy} in ${opts.duration} ${pluralize("day", opts.duration)}.`);
}

export async function checkAccountsForReview (event: TaskRequest<AccountReviewJobData>) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Account reviews can only be submitted from the control subreddit.");
    }

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Account Review: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const runLimit = addSeconds(new Date(), 10);

    const accountsToReview = await redis.zRange(ACCOUNT_REVIEW_QUEUE, 0, Date.now(), { by: "score" });
    if (accountsToReview.length === 0) {
        console.log("No accounts to review.");
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowAccountReminders) {
        await redis.zRem(ACCOUNT_REVIEW_QUEUE, accountsToReview.map(item => item.member));
        console.log("Account review reminders are disabled in the control subreddit settings.");
        return;
    }

    const runRecentlyKey = "accountReviewLastRun";
    if (event.data.firstRun && await redis.exists(runRecentlyKey)) {
        return;
    }

    await redis.set(runRecentlyKey, "true", { expiration: addSeconds(new Date(), 10) });
    const processedItems: string[] = [];

    while (accountsToReview.length > 0 && new Date() < runLimit) {
        const item = accountsToReview.shift();
        if (!item) {
            break;
        }

        processedItems.push(item.member);

        const post = await reddit.getPostById(item.member as T3);
        if (post.authorName === "[deleted]") {
            continue;
        }

        const reviewDataValue = await redis.get(accountReviewKey(item.member));
        if (reviewDataValue) {
            const reviewData = JSON.parse(reviewDataValue) as AccountReviewData;
            const message: json2md.DataObject[] = [];
            if (reviewData.reviewRequestedBy) {
                const username = getUsernameFromUrl(post.url);
                if (username) {
                    const user = await getUserOrUndefined(username);
                    if (!user) {
                        console.log(`Account Review: User ${username} is shadowbanned or does not exist, skipping review reminder.`);
                        continue;
                    }
                }

                message.push({ p: `An account review was requested by /u/${reviewData.reviewRequestedBy ?? "unknown"} for this post: [${post.title}](${post.permalink})` });
                if (reviewData.reviewReason) {
                    message.push({ p: `Reason: ${reviewData.reviewReason}` });
                }

                if (post.flair?.text) {
                    message.push({ p: `Current user status: **${post.flair.text}**` });
                }

                message.push({ p: `[Link to user profile](https://www.reddit.com/user/${username}) | [Rechearch](https://rechear.ch/?kind=submission&author=${username}&limit=100) | [Arctic Shift](https://fsvreddit.github.io/arcticredir/?author=${username}&type=posts)` });

                const subject = username ? `Account review reminder for /u/${username}` : "Account review reminder";
                await reddit.modMail.createModInboxConversation({
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
    await redis.zRem(ACCOUNT_REVIEW_QUEUE, processedItems);

    if (accountsToReview.length > 0) {
        await scheduler.runJob<AccountReviewJobData>({
            name: ControlSubredditJob.AccountReview,
            runAt: addSeconds(new Date(), 5),
            data: { jobGuid: crypto.randomUUID(), firstRun: false },
        });
    } else {
        await redis.del(runRecentlyKey);
    }
}
