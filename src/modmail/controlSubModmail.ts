import { TriggerContext } from "@devvit/public-api";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined, isBanned, isModerator } from "../utility.js";
import { CONFIGURATION_DEFAULTS, getControlSubSettings } from "../settings.js";
import { addDays, addHours, subMinutes } from "date-fns";
import json2md from "json2md";
import { ModmailMessage } from "./modmail.js";
import { dataExtract } from "./dataExtract.js";
import { addAllUsersFromModmail } from "../similarBioTextFinder/bioTextFinder.js";
import { markAppealAsHandled } from "../statistics/appealStatistics.js";
import { statusToFlair } from "../postCreation.js";
import { CONTROL_SUBREDDIT, INTERNAL_BOT } from "../constants.js";
import { handleBulkSubmission } from "./bulkSubmission.js";
import { handleAppeal } from "./autoAppealHandling.js";
import { FLAIR_MAPPINGS } from "../handleControlSubFlairUpdate.js";
import { uniq } from "lodash";
import { CHECK_DATE_KEY } from "../karmaFarmingSubsCheck.js";
import { evaluateAccountFromModmail } from "./modmailEvaluaton.js";

export function getPossibleSetStatusValues (): string[] {
    return uniq([...FLAIR_MAPPINGS.map(entry => entry.postFlair), ...Object.values(UserStatus)]);
}

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

    const setDateRegex = /^!setdate ([A-Za-z0-9_-]+) (\d{4}-\d{2}-\d{2})/;
    const setDateMatch = setDateRegex.exec(modmail.bodyMarkdown);
    if (setDateMatch && setDateMatch.length === 3) {
        const subredditName = setDateMatch[1];
        const dateString = setDateMatch[2];
        const date = new Date(dateString);
        await context.redis.zAdd(CHECK_DATE_KEY, { score: date.getTime(), member: subredditName });
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: `Set the next check date for /r/${subredditName} to ${dateString}.`,
            isInternal: true,
        });
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

    if (modmail.bodyMarkdown.startsWith("!evaluate ")) {
        await evaluateAccountFromModmail(modmail, context);
        return;
    }

    if (modmail.participant && modmail.participant !== context.appName) {
        const statusChangeRegex = new RegExp(`!setstatus (${getPossibleSetStatusValues().join("|")})`);
        const statusChangeMatch = statusChangeRegex.exec(modmail.bodyMarkdown);
        if (statusChangeMatch && statusChangeMatch.length === 2) {
            const newStatus = statusChangeMatch[1] as UserStatus;
            const currentStatus = await getUserStatus(modmail.participant, context);
            if (currentStatus && isLinkId(currentStatus.trackingPostId) && currentStatus.userStatus !== newStatus) {
                await context.redis.set(`userStatusOverride~${modmail.participant}`, modmail.messageAuthor, { expiration: addHours(new Date(), 2) });

                const newFlairTemplate = statusToFlair[newStatus];
                let newFlairText: string | undefined;
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (!newFlairTemplate) {
                    newFlairText = newStatus;
                }
                await context.reddit.setPostFlair({
                    postId: currentStatus.trackingPostId,
                    flairTemplateId: newFlairTemplate,
                    text: newFlairText,
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

    if (username === INTERNAL_BOT || username.startsWith(context.appName)) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus) {
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: "This user is not currently listed in the Bot Bouncer database. This may be a general enquiry, mistaken appeal or a third party appeal from another sub's mods.",
            isInternal: true,
        });
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

    const message = await getSummaryForUser(username, "modmail", context);

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
    const messageText = await getSummaryForUser(username, "modmail", context);

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
