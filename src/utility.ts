import { Comment, Post, TriggerContext, User, UserSocialLink } from "@devvit/public-api";
import { isCommentId, isLinkId } from "@devvit/public-api/types/tid.js";
import { addMinutes } from "date-fns";

export function getUsernameFromUrl (url: string) {
    const urlRegex = /reddit\.com\/u(?:ser)?\/([\w_-]+)\/?(?:[?/].+)?$/i;
    const matches = urlRegex.exec(url);
    if (!matches || matches.length !== 2) {
        return;
    }

    const [, username] = matches;
    return username;
}

export async function isModerator (username: string, context: TriggerContext, subreddit?: string): Promise<boolean> {
    const subredditName = subreddit ?? context.subredditName ?? await context.reddit.getCurrentSubredditName();

    if (username === "AutoModerator" || username === `${subredditName}-ModTeam`) {
        return true;
    }

    const modList = await context.reddit.getModerators({ subredditName, username }).all();
    return modList.length > 0;
}

export async function isApproved (username: string, context: TriggerContext) {
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const approvedList = await context.reddit.getApprovedUsers({ subredditName, username }).all();
    return approvedList.length > 0;
}

export async function isBanned (username: string, context: TriggerContext, subreddit?: string): Promise<boolean> {
    const subredditName = subreddit ?? context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const bannedList = await context.reddit.getBannedUsers({ subredditName, username }).all();
    return bannedList.length > 0;
}

export function replaceAll (input: string, pattern: string, replacement: string): string {
    return input.split(pattern).join(replacement);
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

export async function getUserOrUndefined (username: string, context: TriggerContext): Promise<User | undefined> {
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(username);
    } catch (err) {
        if (context.userId === "t2_g0jld") {
            console.log(`Error retrieving user ${username}:`, err);
        }
        //
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

export async function sendMessageToWebhook (webhookUrl: string, message: string) {
    const params = {
        content: replaceAll(replaceAll(message, "\n\n\n", "\n\n"), "\n\n", "\n"),
    };

    await fetch(
        webhookUrl,
        {
            method: "post",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(params),
        },
    );
}

export async function getUserSocialLinks (username: string, context: TriggerContext): Promise<UserSocialLink[]> {
    const socialLinksCacheKey = `userSocialLinks~${username}`;
    const cachedLinks = await context.redis.get(socialLinksCacheKey);
    if (cachedLinks) {
        return JSON.parse(cachedLinks) as UserSocialLink[];
    }

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return [];
    }

    const socialLinks = await user.getSocialLinks();
    await context.redis.set(socialLinksCacheKey, JSON.stringify(socialLinks), { expiration: addMinutes(new Date(), 20) });
    return socialLinks;
}
