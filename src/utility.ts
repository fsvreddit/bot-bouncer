import { Comment, Post, TriggerContext, User } from "@devvit/public-api";
import { isCommentId, isLinkId } from "@devvit/public-api/types/tid.js";
import { addHours } from "date-fns";
import { isModerator } from "devvit-helpers";

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

    const cacheKey = `modStatus:${subredditName}:${username}`;
    const cachedValue = await context.redis.get(cacheKey);
    if (cachedValue !== undefined) {
        return JSON.parse(cachedValue) as boolean;
    }

    const isAMod = await isModerator(context.reddit, subredditName, username);

    await context.redis.set(cacheKey, JSON.stringify(isAMod), { expiration: addHours(new Date(), 1) });
    return isAMod;
}

export function getPostOrCommentById (thingId: string, context: TriggerContext): Promise<Post | Comment> {
    if (isCommentId(thingId)) {
        return context.reddit.getCommentById(thingId);
    } else if (isLinkId(thingId)) {
        return context.reddit.getPostById(thingId);
    } else {
        throw new Error(`Invalid thingId ${thingId}`);
    }
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
        console.log("Webhook message sent, status:", result.status);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const json = await result.json();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
        return json.id;
    } catch (error) {
        console.error("Error sending message to webhook:", error);
    }
}

export async function updateWebhookMessage (webhookUrl: string, messageId: string, newMessage: string): Promise<void> {
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
        console.log("Webhook message updated, status:", result.status);
    } catch (error) {
        console.error("Error updating message to webhook:", error);
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
