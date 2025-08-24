import { TriggerContext } from "@devvit/public-api";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined, isBanned, isModerator } from "../utility.js";
import { CONFIGURATION_DEFAULTS, getControlSubSettings } from "../settings.js";
import { addDays, addMinutes, subMinutes } from "date-fns";
import json2md from "json2md";
import { ModmailMessage } from "./modmail.js";
import { dataExtract } from "./dataExtract.js";
import { addAllUsersFromModmail } from "../similarBioTextFinder/bioTextFinder.js";
import { markAppealAsHandled } from "../statistics/appealStatistics.js";
import { statusToFlair } from "../postCreation.js";
import { CONTROL_SUBREDDIT, INTERNAL_BOT } from "../constants.js";
import { handleBulkSubmission } from "./bulkSubmission.js";
import { handleAppeal } from "./autoAppealHandling.js";

export async function handleControlSubredditModmail (modmail: ModmailMessage, context: TriggerContext) {
    const controlSubSettings = await getControlSubSettings(context);

    if (controlSubSettings.bulkSubmitters?.includes(modmail.messageAuthor) && modmail.bodyMarkdown.startsWith("{")) {
        const isTrusted = controlSubSettings.trustedSubmitters.includes(modmail.messageAuthor);
        await handleBulkSubmission(modmail.messageAuthor, isTrusted, modmail.conversationId, modmail.bodyMarkdown, context);
        return;
    }

    if (modmail.isFirstMessage && modmail.messageAuthor === modmail.participant) {
        await handleModmailFromUser(modmail, context);
        return;
    }

    // Everything from here on is for modmail sent by moderators.
    if (!modmail.messageAuthorIsMod) {
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!extract")) {
        await dataExtract(modmail.bodyMarkdown, modmail.conversationId, context);
        return;
    }

    const addAllRegex = /^!addall(?: (banned))?/;
    const addAllMatches = addAllRegex.exec(modmail.bodyMarkdown);
    if (addAllMatches && addAllMatches.length === 2) {
        const status = addAllMatches[1] === "banned" ? UserStatus.Banned : UserStatus.Pending;
        await addAllUsersFromModmail(modmail.conversationId, modmail.messageAuthor, status, context);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!summary") && modmail.participant) {
        await addSummaryForUser(modmail.conversationId, modmail.participant, context);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!checkban") && modmail.participant) {
        await checkBanOnSub(modmail, context);
        return;
    }

    if (!modmail.isInternal && modmail.messageAuthor !== context.appName) {
        await markAppealAsHandled(modmail, context);
    }

    if (modmail.participant && modmail.participant !== context.appName) {
        const statusChangeRegex = new RegExp(`!setstatus (${Object.values(UserStatus).join("|")})`);
        const statusChangeMatch = statusChangeRegex.exec(modmail.bodyMarkdown);
        if (statusChangeMatch && statusChangeMatch.length === 2) {
            const newStatus = statusChangeMatch[1] as UserStatus;
            const currentStatus = await getUserStatus(modmail.participant, context);
            if (currentStatus && isLinkId(currentStatus.trackingPostId) && currentStatus.userStatus !== newStatus) {
                await context.redis.set(`userStatusOverride~${modmail.participant}`, modmail.messageAuthor, { expiration: addMinutes(new Date(), 5) });

                const newFlair = statusToFlair[newStatus];
                await context.reddit.setPostFlair({
                    postId: currentStatus.trackingPostId,
                    flairTemplateId: newFlair,
                    subredditName: CONTROL_SUBREDDIT,
                });

                await context.reddit.modMail.reply({
                    conversationId: modmail.conversationId,
                    body: `User status changed to ${newStatus}.`,
                    isInternal: true,
                });
            }
        }
    }
}

export function markdownToText (markdown: json2md.DataObject[], limit = 9500): string[] {
    const text = json2md(markdown);
    if (text.length < limit) {
        return [text];
    }

    console.log(`Markdown to text conversion: ${text.length} > ${limit}`);

    const workingMarkdown = [...markdown];

    // Split the markdown into chunks that fit within the limit
    const chunks: string[] = [];
    let currentChunkMarkdown: json2md.DataObject[] = [];
    while (workingMarkdown.length > 0) {
        const firstElement = workingMarkdown.shift();
        if (!firstElement) {
            // Impossible, but satisfy the TypeScript compiler
            break;
        }
        const text = json2md([...currentChunkMarkdown, firstElement]);
        if (text.length > limit) {
            chunks.push(json2md(currentChunkMarkdown));
            console.log(`Markdown to text conversion: ${text.length} > ${limit}, chunk size: ${currentChunkMarkdown.length}`);
            currentChunkMarkdown = []; // Clear the current chunk
        }
        currentChunkMarkdown.push(firstElement);
    }

    // Add the last chunk if it exists
    if (currentChunkMarkdown.length > 0) {
        chunks.push(json2md(currentChunkMarkdown));
    }

    return chunks;
}

async function handleModmailFromUser (modmail: ModmailMessage, context: TriggerContext) {
    const username = modmail.messageAuthor;

    if (username === INTERNAL_BOT) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus || currentStatus.userStatus === UserStatus.Pending) {
        return;
    }

    if (modmail.subject.startsWith(`Ban dispute for /u/${username}`) && (currentStatus.userStatus === UserStatus.Organic || currentStatus.userStatus === UserStatus.Declined)) {
        console.log(`Modmail: /u/${username} is appealing a ban, but is currently marked as human. Sending reply.`);
        const message: json2md.DataObject[] = [
            { p: `Hi /u/${username},` },
            { p: "Thanks for appealing your ban. A moderator of /r/BotBouncer has already reviewed your account proactively and marked you as human." },
        ];

        if (new Date(currentStatus.lastUpdate) < subMinutes(new Date(), 10)) {
            message.push({ p: "Any bans received should have already lifted, and you should already be able to post or comment again." });
        } else {
            message.push({ p: "This was done recently, so you may need to wait up to ten minutes for bans to lift." });
        }

        message.push({ p: "Please accept our apologies for the inconvenience or worry this may have caused you." });
        message.push({ p: "*This is an automated message.*" });

        await context.reddit.modMail.reply({
            body: json2md(message),
            conversationId: modmail.conversationId,
            isInternal: false,
            isAuthorHidden: true,
        });
        await context.reddit.modMail.archiveConversation(modmail.conversationId);
        return;
    }

    const recentAppealKey = `recentAppeal~${username}`;
    const recentAppealMade = await context.redis.get(recentAppealKey);

    if (recentAppealMade) {
        // User has already made an appeal recently, so we should tell the user it's already being handled.
        await context.reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.recentAppealMade,
            conversationId: modmail.conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(modmail.conversationId);
        return;
    }

    await storeKeyForAppeal(modmail.conversationId, context);

    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    const message: json2md.DataObject[] = [
        { p: `/u/${username} is currently listed as ${currentStatus.userStatus}, set by ${currentStatus.operator} at ${new Date(currentStatus.lastUpdate).toUTCString()} and reported by ${currentStatus.submitter ?? "unknown"}` },
        { link: { title: "Link to submission", source: `https://www.reddit.com${post.permalink}` } },
    ];

    if (currentStatus.userStatus === UserStatus.Banned || currentStatus.userStatus === UserStatus.Purged) {
        const userSummary = await getSummaryForUser(username, "modmail", context);
        if (userSummary) {
            message.push(userSummary);
        }
    }

    const modmailStrings = markdownToText(message);

    for (const string of modmailStrings) {
        await context.reddit.modMail.reply({
            body: string,
            conversationId: modmail.conversationId,
            isInternal: true,
        });
    }

    if (currentStatus.userStatus !== UserStatus.Banned && currentStatus.userStatus !== UserStatus.Purged) {
        // User is not banned or purged, so we should not send the "Appeal Received" message.
        return;
    }

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        // User is not found, so we should not send the "Appeal Received" message.
        await context.reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.appealShadowbannedMessage,
            conversationId: modmail.conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(modmail.conversationId);
        return;
    }

    await handleAppeal(modmail, currentStatus, context);

    await context.redis.set(recentAppealKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 1) });
}

function getKeyForAppeal (conversationId: string): string {
    return `appeal~${conversationId}`;
}

async function storeKeyForAppeal (conversationId: string, context: TriggerContext) {
    const key = getKeyForAppeal(conversationId);
    const existingValue = await context.redis.exists(key);
    if (!existingValue) {
        await context.redis.set(key, new Date().getTime().toString(), { expiration: addDays(new Date(), 28) });
    }
}

export async function isActiveAppeal (conversationId: string, context: TriggerContext): Promise<boolean> {
    const key = getKeyForAppeal(conversationId);
    const value = await context.redis.get(key);
    return value !== undefined;
}

export async function deleteKeyForAppeal (conversationId: string, context: TriggerContext) {
    const key = getKeyForAppeal(conversationId);
    await context.redis.del(key);
}

async function addSummaryForUser (conversationId: string, username: string, context: TriggerContext) {
    const userSummary = await getSummaryForUser(username, "modmail", context);
    const shadowbannedSummary: json2md.DataObject[] = [
        { p: "No summary available, user may be shadowbanned." },
    ];
    const messageText = userSummary ?? shadowbannedSummary;

    const modmailStrings = markdownToText(messageText);

    for (const string of modmailStrings) {
        await context.reddit.modMail.reply({
            body: string,
            conversationId,
            isInternal: true,
        });
    }
}

async function checkBanOnSub (modmail: ModmailMessage, context: TriggerContext) {
    const checkBanRegex = /^!checkban ([A-Za-z0-9_]+)/;
    const checkBanMatch = checkBanRegex.exec(modmail.bodyMarkdown);
    if (!modmail.participant || !checkBanMatch || checkBanMatch.length !== 2) {
        await context.reddit.modMail.reply({
            body: "Invalid command format. Use `!checkban <subreddit>`.",
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    const subredditName = checkBanMatch[1];
    const message: json2md.DataObject[] = [];
    try {
        const isBannedOnSub = await isBanned(modmail.participant, context, subredditName);
        message.push({ p: `User /u/${modmail.participant} is currently ${isBannedOnSub ? "banned" : "not banned"} on /r/${subredditName}.` });
    } catch (error) {
        const isMod = await isModerator(context.appName, context, subredditName);
        if (!isMod) {
            message.push({ p: `Bot Bouncer is not a moderator of /r/${subredditName}, so it cannot check the ban status of /u/${modmail.participant}.` });
        } else {
            message.push({ p: `An error occurred while checking the ban status of /u/${modmail.participant} on /r/${subredditName}.` });
            message.push({ blockquote: error instanceof Error ? error.message : String(error) });
        }
    }
    await context.reddit.modMail.reply({
        body: json2md(message),
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}
