import { TriggerContext, User } from "@devvit/public-api";
import { addDays, addHours, formatDuration, intervalToDuration } from "date-fns";
import { isBanned, isModerator } from "devvit-helpers";
import Pako from "pako";

export function getUsernameFromUrl (url: string) {
    const urlRegex = /reddit\.com\/u(?:ser)?\/([\w_-]+)\/?(?:[?/].+)?$/i;
    const matches = urlRegex.exec(url);
    if (matches?.length !== 2) {
        return;
    }

    const [, username] = matches;
    return username;
}

export async function isModeratorWithCache (username: string, context: TriggerContext, subreddit?: string): Promise<boolean> {
    const subredditName = subreddit ?? context.subredditName ?? await context.reddit.getCurrentSubredditName();

    if (username === "AutoModerator" || username === `${subredditName}-ModTeam`) {
        return true;
    }

    const cacheKey = `modStatusValue:${subredditName}:${username}`;
    const cachedValue = await context.redis.get(cacheKey);
    if (cachedValue !== undefined) {
        return JSON.parse(cachedValue) as boolean;
    }

    const isAMod = await isModerator(context.reddit, subredditName, username);

    await context.redis.set(cacheKey, JSON.stringify(isAMod), { expiration: addHours(new Date(), 1) });
    return isAMod;
}

function getBanCacheKey (username: string, subredditName: string) {
    return `banStatusValue:${subredditName}:${username}`;
}

export async function removeCachedBanStatus (username: string, context: TriggerContext) {
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const cacheKey = getBanCacheKey(username, subredditName);
    await context.redis.del(cacheKey);
}

export async function isBannedWithCache (username: string, context: TriggerContext, subredditName?: string, cacheUntil?: Date): Promise<boolean> {
    const subName = subredditName ?? context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const cacheKey = getBanCacheKey(username, subName);
    const cachedValue = await context.redis.get(cacheKey);
    if (cachedValue !== undefined) {
        return JSON.parse(cachedValue) as boolean;
    }

    const isUserBanned = await isBanned(context.reddit, subName, username);
    await context.redis.set(cacheKey, JSON.stringify(isUserBanned), { expiration: cacheUntil ?? addDays(new Date(), 1) });
    return isUserBanned;
}

export async function getUserOrUndefined (username: string, context: TriggerContext, logError = false): Promise<User | undefined> {
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(username);
    } catch (err) {
        if (logError) {
            console.error(`Error retrieving user ${username}:`, err);
        }
    }
    return user;
}

export function domainFromUrl (url: string): string | undefined {
    if (!url || url.startsWith("/")) {
        // Reddit internal link or crosspost
        return;
    }

    const hostname = new URL(url).hostname;
    const trimmedHostname = hostname.startsWith("www.") ? hostname.substring(4) : hostname;

    return trimmedHostname;
}

export function median (numbers: number[]): number {
    const sorted = numbers.sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
}

export async function sendMessageToWebhook (webhookUrl: string, message: string): Promise<string | undefined> {
    const params = {
        content: message.replaceAll("\n\n\n", "\n\n").replaceAll("\n\n", "\n"),
    };

    const pathParams = new URLSearchParams();
    pathParams.append("wait", "true");

    try {
        const result = await fetch(
            `${webhookUrl}?${pathParams}`,
            {
                method: "post",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(params),
            },
        );
        if (!result.ok) {
            const responseBody = await result.text();
            console.error(`Webhook send failed with status ${result.status}:`, responseBody);
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const json = await result.json();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        const messageId = json.id;
        if (typeof messageId !== "string" || messageId.length === 0) {
            console.error("Webhook send succeeded but response did not include a valid message id.");
            return;
        }

        console.log("Webhook message sent, status:", result.status);
        return messageId;
    } catch (error) {
        console.error("Error sending message to webhook:", error);
    }
}

export async function updateWebhookMessage (webhookUrl: string, messageId: string, newMessage: string): Promise<boolean> {
    const params = {
        content: newMessage.replaceAll("\n\n\n", "\n\n").replaceAll("\n\n", "\n"),
    };

    try {
        const result = await fetch(
            `${webhookUrl}/messages/${messageId}`,
            {
                method: "patch",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(params),
            },
        );
        if (!result.ok) {
            const responseBody = await result.text();
            console.error(`Webhook update failed with status ${result.status}:`, responseBody);
            return false;
        }

        console.log("Webhook message updated, status:", result.status);
        return true;
    } catch (error) {
        console.error("Error updating message to webhook:", error);
        return false;
    }
}

export function encodedText (input: string): string {
    return Buffer.from(input, "utf-8").toString("base64");
}

export function decodedText (input: string): string {
    return Buffer.from(input, "base64").toString("utf-8");
}

export function postIdToShortLink (postId: string): string {
    return `https://redd.it/${postId.replace("t3_", "")}`;
}

export function compressData (value: unknown): string {
    return Buffer.from(Pako.deflate(JSON.stringify(value), { level: 9 })).toString("base64");
}

export function conditionallyCompressString (input: string): string {
    const compressed = `c:${Buffer.from(Pako.deflate(input, { level: 9 })).toString("base64")}`;

    // In the unlikely event that the input starts with c: (this is intended for JSON so not likely),
    // return the compressed value to avoid errors in decompression.
    if (input.startsWith("c:")) {
        return compressed;
    }

    return compressed.length < input.length ? compressed : input;
}

export function conditionallyDecompressString (input: string): string {
    if (input.startsWith("c:")) {
        return Buffer.from(Pako.inflate(Buffer.from(input.substring(2), "base64"))).toString();
    } else {
        return input;
    }
}

export function formatTimeSince (date: Date): string {
    const interval = intervalToDuration({ start: date, end: new Date() });
    return formatDuration(interval, { format: ["days", "hours", "minutes"] });
}
