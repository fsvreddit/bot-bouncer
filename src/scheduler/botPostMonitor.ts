import { JobContext, Post } from "@devvit/public-api";
import { differenceInMinutes } from "date-fns";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { ControlSubSettings, getControlSubSettings } from "../settings.js";
import { postIdToShortLink, sendMessageToWebhook } from "../utility.js";

const BOT_POST_MONITOR_ALERT_KEY = "botPostMonitorAlertSent";
const BOT_POST_MONITOR_LAST_POST_KEY = "botPostMonitorLastPost";
export const BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES = 20;

type CreatedPost = Pick<Post, "createdAt" | "id">;

export interface BotPostRecord {
    createdAt: Date;
    id?: string;
}

export interface BotPostFreshnessResult {
    latestPost?: BotPostRecord;
    minutesSinceLatestPost?: number;
    stale: boolean;
}

export function getBotPostMonitorThresholdMinutes (settings: Pick<ControlSubSettings, "botPostMonitorThresholdMinutes">): number {
    const configuredThreshold = settings.botPostMonitorThresholdMinutes;
    if (configuredThreshold === undefined || configuredThreshold < 1) {
        return BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES;
    }

    return Math.floor(configuredThreshold);
}

export function getBotPostFreshness (latestPost: BotPostRecord | undefined, thresholdMinutes: number, now = new Date()): BotPostFreshnessResult {
    if (!latestPost) {
        return { stale: false };
    }

    const minutesSinceLatestPost = differenceInMinutes(now, latestPost.createdAt);
    return {
        latestPost,
        minutesSinceLatestPost,
        stale: minutesSinceLatestPost >= thresholdMinutes,
    };
}

function serializeBotPostRecord (record: BotPostRecord): string {
    return JSON.stringify({
        createdAt: record.createdAt.toISOString(),
        id: record.id,
    });
}

function parseBotPostRecord (record: string): BotPostRecord | undefined {
    try {
        const parsed = JSON.parse(record) as { createdAt?: string; id?: string };
        if (!parsed.createdAt) {
            return undefined;
        }

        const createdAt = new Date(parsed.createdAt);
        if (Number.isNaN(createdAt.getTime())) {
            return undefined;
        }

        return {
            createdAt,
            id: parsed.id,
        };
    } catch (error) {
        console.error("Bot Post Monitor: Error parsing recorded bot post details.", error);
        return undefined;
    }
}

async function getLatestBotPostRecord (context: JobContext): Promise<BotPostRecord | undefined> {
    const record = await context.redis.get(BOT_POST_MONITOR_LAST_POST_KEY);
    return record ? parseBotPostRecord(record) : undefined;
}

async function initializeBotPostMonitorRecord (context: JobContext) {
    await context.redis.set(BOT_POST_MONITOR_LAST_POST_KEY, serializeBotPostRecord({ createdAt: new Date() }));
}

export async function recordBotPostCreated (post: CreatedPost, context: Pick<JobContext, "redis">) {
    await context.redis.set(BOT_POST_MONITOR_LAST_POST_KEY, serializeBotPostRecord({
        createdAt: post.createdAt,
        id: post.id,
    }));
}

function botPostAlertMessage (botUsername: string, freshness: BotPostFreshnessResult, thresholdMinutes: number): string {
    if (!freshness.latestPost || freshness.minutesSinceLatestPost === undefined) {
        return `🚨 No r/${CONTROL_SUBREDDIT} post creation record is available for u/${botUsername}. Post creation may be stalled.`;
    }

    if (!freshness.latestPost.id) {
        return `🚨 No r/${CONTROL_SUBREDDIT} post by u/${botUsername} has been recorded for ${freshness.minutesSinceLatestPost.toLocaleString()} minutes since the monitor started. Alert threshold: ${thresholdMinutes.toLocaleString()} minutes.`;
    }

    const postCreatedAtUnix = Math.floor(freshness.latestPost.createdAt.getTime() / 1000);
    return `🚨 u/${botUsername} has not created a new r/${CONTROL_SUBREDDIT} post in ${freshness.minutesSinceLatestPost.toLocaleString()} minutes. Alert threshold: ${thresholdMinutes.toLocaleString()} minutes. Latest recorded post: <${postIdToShortLink(freshness.latestPost.id)}> created <t:${postCreatedAtUnix}:R>.`;
}

function botPostRecoveryMessage (botUsername: string, freshness: BotPostFreshnessResult): string {
    if (!freshness.latestPost?.id) {
        return `✅ u/${botUsername} has resumed creating r/${CONTROL_SUBREDDIT} posts.`;
    }

    const postCreatedAtUnix = Math.floor(freshness.latestPost.createdAt.getTime() / 1000);
    return `✅ u/${botUsername} created a new r/${CONTROL_SUBREDDIT} post at <t:${postCreatedAtUnix}:T>: <${postIdToShortLink(freshness.latestPost.id)}>.`;
}

export async function checkBotPostFreshness (context: JobContext) {
    const settings = await getControlSubSettings(context);
    if (!settings.botPostMonitoringEnabled) {
        console.log("Bot Post Monitor: Monitor is disabled.");
        return;
    }

    if (!settings.postCreationQueueProcessingEnabled) {
        console.log("Bot Post Monitor: Post creation queue processing is disabled.");
        return;
    }

    const webhookUrl = settings.botNotificationsWebhook;
    if (!webhookUrl) {
        console.log("Bot Post Monitor: No bot notifications webhook configured.");
        return;
    }

    let latestPost = await getLatestBotPostRecord(context);
    if (!latestPost) {
        console.log("Bot Post Monitor: No post creation record found. Initializing monitor timestamp.");
        await initializeBotPostMonitorRecord(context);
        latestPost = await getLatestBotPostRecord(context);
    }

    const botUsername = context.appSlug;
    const thresholdMinutes = getBotPostMonitorThresholdMinutes(settings);
    const freshness = getBotPostFreshness(latestPost, thresholdMinutes);
    const existingAlertSentAt = await context.redis.get(BOT_POST_MONITOR_ALERT_KEY);

    if (!freshness.stale) {
        if (existingAlertSentAt) {
            await sendMessageToWebhook(webhookUrl, botPostRecoveryMessage(botUsername, freshness));
            await context.redis.del(BOT_POST_MONITOR_ALERT_KEY);
        }
        return;
    }

    if (existingAlertSentAt) {
        console.log("Bot Post Monitor: Stale bot post alert already sent.");
        return;
    }

    const messageId = await sendMessageToWebhook(webhookUrl, botPostAlertMessage(botUsername, freshness, thresholdMinutes));
    if (messageId) {
        await context.redis.set(BOT_POST_MONITOR_ALERT_KEY, Date.now().toString());
    }
}
