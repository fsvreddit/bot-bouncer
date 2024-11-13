import { TriggerContext } from "@devvit/public-api";

export function getUsernameFromUrl (url: string) {
    const urlRegex = /reddit\.com\/u(?:ser)?\/([\w_-]+)$/i;
    const matches = urlRegex.exec(url);
    if (!matches || matches.length !== 2) {
        return;
    }

    const [, username] = matches;
    return username;
}

export async function isModerator (username: string, context: TriggerContext) {
    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
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
