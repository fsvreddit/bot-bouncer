import { Comment, Post, TriggerContext, User } from "@devvit/public-api";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

export function getUsernameFromUrl (url: string) {
    const urlRegex = /reddit\.com\/u(?:ser)?\/([\w_-]+)\/?(?:\?.+)?$/i;
    const matches = urlRegex.exec(url);
    if (!matches || matches.length !== 2) {
        return;
    }

    const [, username] = matches;
    return username;
}

export async function isModerator (username: string, context: TriggerContext) {
    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    if (username === "AutoModerator" || username === `${subredditName}-ModTeam`) {
        return true;
    }

    const modList = await context.reddit.getModerators({ subredditName, username }).all();
    return modList.length > 0;
}

export async function isApproved (username: string, context: TriggerContext) {
    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
    const approvedList = await context.reddit.getModerators({ subredditName, username }).all();
    return approvedList.length > 0;
}

export async function isBanned (username: string, context: TriggerContext) {
    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
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
    } catch {
        //
    }
    return user;
}
