import { context, reddit, redis, scheduler } from "@devvit/web/server";
import { isT1, isT3 } from "@devvit/web/shared";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { accountIsBotBouncerApp, CHECK_DATE_KEY, CONFIGURATION_DEFAULTS, CONTROL_SUBREDDIT, ControlSubredditJob, FLAIR_MAPPINGS, getControlSubSettings, getPostFlairUpdateIgnoreKey, getUserStatus, INTERNAL_BOT, isModeratorWithCache, ModmailMessage, setUserStatus, statusOrFlagToStatusAndFlags, statusToFlair, UserDetails, UserFlag } from "../..";
import { count } from "@wordpress/wordcount";
import { AppealOutcomeType, clearRespondToFurtherMessagesFlag, getAppealConfig, getMatchedAppealConfig, getRespondToFurtherMessagesFlag, handleAppeal, storeAppealRecordsForUser } from "./appealHandling";
import { addDays, addHours, addMinutes, addSeconds, addWeeks, format, subMinutes } from "date-fns";
import json2md from "json2md";
import { getUserExtended, getUserOrUndefined } from "@fsvreddit/fsv-devvit-web-helpers";
import { getSummaryForUser } from "../userSummary";
import pluralize from "pluralize";
import { addConversationToModmailArchiverQueue } from "./modmailArchiver";
import { handleHighlightedModmail } from "./unhighlighter";
import { handleBulkSubmission, retryBulkSubmission } from "./bulkSubmission";
import { dataExtract } from "./dataExtract";
import { evaluateAccountFromModmail } from "./modmailEvaluaton";
import { handleReversalCommand } from ".";
import { addAllUsersFromModmail } from "../similarBioTextFinder";
import { OpenAISummaryGatherData } from "../../../tasks";
import { markAppealAsHandledByMod } from "../statistics";
import { handleAskAI } from "../aiAnalysis";
import { uniq } from "lodash-es";

export function getPossibleSetStatusValues (): string[] {
    return uniq([...FLAIR_MAPPINGS.map(entry => entry.postFlair), ...Object.values(UserStatus)]);
}

export async function handleControlSubredditModmail (modmail: ModmailMessage) {
    await addConversationToModmailArchiverQueue(modmail);

    const controlSubSettings = await getControlSubSettings();

    await handleHighlightedModmail(modmail);

    if (controlSubSettings.bulkSubmitters?.includes(modmail.messageAuthor) && modmail.bodyMarkdown.startsWith("{")) {
        const trustedSubmitters = new Set(controlSubSettings.trustedSubmitters.map(entry => entry.toLowerCase()));
        const isTrusted = trustedSubmitters.has(modmail.messageAuthor.toLowerCase());
        await handleBulkSubmission(modmail.messageAuthor, isTrusted, modmail.conversationId, modmail.bodyMarkdown);
        return;
    }

    if (modmail.isFirstMessage && modmail.messageAuthor === modmail.participant) {
        await handleModmailFromUser(modmail);
        return;
    }

    if (!modmail.isFirstMessage && modmail.messageAuthor === modmail.participant) {
        if (modmail.bodyMarkdown.toLowerCase().includes("thank") && count(modmail.bodyMarkdown, "words") <= 4) {
            const currentStatus = await getUserStatus(modmail.messageAuthor);
            if (currentStatus?.userStatus === UserStatus.Organic) {
                console.log(`Modmail: ℹ️ ${modmail.messageAuthor} sent a 'thank you' message. Archiving.`);
                await reddit.modMail.archiveConversation(modmail.conversationId);
                return;
            }
        }
    }

    if (!modmail.isFirstMessage && modmail.messageAuthor === modmail.participant && await getRespondToFurtherMessagesFlag(modmail.conversationId)) {
        const currentStatus = await getUserStatus(modmail.messageAuthor);
        if (currentStatus?.userStatus === UserStatus.Banned) {
            const appealOutcome = await handleAppeal(modmail, currentStatus, true);
            if (appealOutcome === AppealOutcomeType.AppealGranted) {
                console.log(`Modmail: ℹ️ ${modmail.messageAuthor} sent a followup message in an appeal conversation. Appeal granted.`);
            }
            await clearRespondToFurtherMessagesFlag(modmail.conversationId);
        }
    }

    // Everything from here on is for modmail sent by moderators.
    if (!modmail.messageAuthorIsMod) {
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!extract")) {
        await dataExtract(modmail, modmail.conversationId);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!reverse")) {
        await handleReversalCommand(modmail);
        return;
    }

    const setDateRegex = /^!setdate ([A-Za-z0-9_-]+) (\d{4}-\d{2}-\d{2})/;
    const setDateMatch = setDateRegex.exec(modmail.bodyMarkdown);
    if (setDateMatch?.length === 3) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const subredditName = setDateMatch[1]!;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const dateString = setDateMatch[2]!;
        const date = new Date(dateString);
        await redis.zAdd(CHECK_DATE_KEY, { score: date.getTime(), member: subredditName });
        await reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: `Set the next check date for /r/${subredditName} to ${dateString}.`,
            isInternal: true,
        });
    }

    const addAllRegex = /^!addall(?: (banned))?/;
    const addAllMatches = addAllRegex.exec(modmail.bodyMarkdown);
    if (addAllMatches?.length === 2) {
        const status = addAllMatches[1] === "banned" ? UserStatus.Banned : UserStatus.Pending;
        await addAllUsersFromModmail(modmail.conversationId, modmail.messageAuthor, status);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!summary")) {
        const regex = /^!summary(?: ([\w\d_-]+))?/;
        const match = regex.exec(modmail.bodyMarkdown);
        const username = match?.[1] ?? modmail.participant;
        if (username) {
            await addSummaryForUser(modmail.conversationId, username);
            return;
        }
    }

    if (modmail.bodyMarkdown.startsWith("!aisummary")) {
        const regex = /^!aisummary(#\w+)?(?: ([\w\d_-]+))?/;
        const match = regex.exec(modmail.bodyMarkdown);
        const promptName = match?.[1]?.substring(1);
        const username = match?.[2] ?? modmail.participant;
        if (username) {
            await scheduler.runJob<OpenAISummaryGatherData>({
                name: ControlSubredditJob.OpenAISummaryGather,
                runAt: new Date(),
                data: {
                    username,
                    mode: "manual",
                    conversationId: modmail.conversationId,
                    jobGuid: crypto.randomUUID(),
                    promptName,
                },
            });
            return;
        }
    }

    if (modmail.bodyMarkdown.startsWith("!checkban") && modmail.participant) {
        await checkBanOnSub(modmail);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!unban") && modmail.participant) {
        await handleUnbanCommand(modmail);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!askai")) {
        await handleAskAI(modmail);
        return;
    }

    if (!modmail.isInternal && modmail.messageAuthor !== context.appSlug) {
        await markAppealAsHandledByMod(modmail);
    }

    if (modmail.bodyMarkdown.startsWith("!evaluate ")) {
        await evaluateAccountFromModmail(modmail);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!history ")) {
        await showUserHistory(modmail);
        return;
    }

    if (modmail.bodyMarkdown.startsWith("!retrybulk")) {
        await retryBulkSubmission(modmail);
        return;
    }

    if (modmail.participant && modmail.participant !== context.appSlug) {
        const statusChangeRegex = new RegExp(`!setstatus (${getPossibleSetStatusValues().join("|")})`);
        const statusChangeMatch = statusChangeRegex.exec(modmail.bodyMarkdown);
        if (statusChangeMatch?.length === 2) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            const newStatus = statusChangeMatch[1] as UserStatus | UserFlag;

            const username = await getOverrideForSetStatusCommand(modmail.conversationId) ?? modmail.participant;

            const currentStatus = await getUserStatus(username);
            if (currentStatus && isT3(currentStatus.trackingPostId) && currentStatus.userStatus !== newStatus) {
                await redis.set(`userStatusOverrideValue~${username}`, modmail.messageAuthor, { expiration: addHours(new Date(), 2) });

                const { status: newStatusValue, flags: newFlags } = statusOrFlagToStatusAndFlags(newStatus);

                const newFlairTemplate = statusToFlair[newStatusValue];
                let newFlairText: string | undefined;
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (!newFlairTemplate) {
                    newFlairText = newStatusValue;
                }

                const statusToSet: UserDetails = {
                    ...currentStatus,
                    userStatus: newStatusValue,
                    flags: newFlags,
                    operator: modmail.messageAuthor,
                    lastUpdate: Date.now(),
                    lastStatus: undefined,
                };

                const results = await Promise.allSettled([
                    redis.set(getPostFlairUpdateIgnoreKey(currentStatus.trackingPostId), "true", { expiration: addMinutes(new Date(), 1) }),
                    setUserStatus(username, statusToSet),
                    reddit.setPostFlair({
                        postId: currentStatus.trackingPostId,
                        flairTemplateId: newFlairTemplate,
                        text: newFlairText,
                        subredditName: CONTROL_SUBREDDIT,
                    }),
                ]);

                let responseForModmail: string;
                if (results.every(result => result.status === "fulfilled")) {
                    responseForModmail = `Successfully updated status and flair for ${username}. New status: ${newStatusValue}.`;
                    if (newFlags) {
                        responseForModmail += ` New flags set: ${newFlags.join(", ")}`;
                    }
                } else {
                    responseForModmail = `Errors occurred when updating status and flair for ${username}.`;
                    if (results[1].status === "rejected") {
                        responseForModmail += ` Could not write user status to Redis.`;
                    }
                    if (results[2].status === "rejected") {
                        responseForModmail += ` Could not set post flair on the user's tracking post.`;
                    }
                }

                console.log(`Modmail: ${responseForModmail}`);

                await reddit.modMail.reply({
                    conversationId: modmail.conversationId,
                    body: responseForModmail,
                    isInternal: true,
                });
            } else {
                await reddit.modMail.reply({
                    conversationId: modmail.conversationId,
                    body: `Did not set status for ${username}, either no existing status or they are already marked as ${newStatus}.`,
                    isInternal: true,
                });
            }
        }
    }

    if (modmail.participant && modmail.bodyMarkdown.startsWith("!testappeal")) {
        const appealConfigs = await getAppealConfig();
        const currentStatus = await getUserStatus(modmail.participant);
        if (!currentStatus) {
            await reddit.modMail.reply({
                conversationId: modmail.conversationId,
                body: "User does not have a status, so cannot check the auto appeal handling",
                isInternal: true,
            });
        } else {
            const statusToCheck: UserDetails = {
                ...currentStatus,
                userStatus: UserStatus.Banned,
            };

            const matchedAppealConfig = await getMatchedAppealConfig(modmail.participant, statusToCheck, appealConfigs, modmail.firstMessageBodyMarkdown, true);
            let response: string;
            if (matchedAppealConfig) {
                response = `Matched appeal config: ${matchedAppealConfig.name}`;
            } else {
                response = `Did not match any of the ${appealConfigs.length} appeal configs`;
            }
            await reddit.modMail.reply({
                conversationId: modmail.conversationId,
                body: response,
                isInternal: true,
            });
        }
    }
}

export function markdownToText (markdown: json2md.DataObject[], limit = 5000): string[] {
    const text = json2md(markdown);
    if (text.length < limit) {
        return [text];
    }

    const chunks: string[] = [];

    let workingChunk = "";
    for (const line of text.split("\n")) {
        if (workingChunk.length + line.length + 1 > limit) {
            chunks.push(workingChunk);
            workingChunk = "";
        }
        workingChunk += line + "\n";
    }
    if (workingChunk.length > 0) {
        chunks.push(workingChunk);
    }

    return chunks;
}

async function handleModmailFromUser (modmail: ModmailMessage) {
    const username = modmail.messageAuthor;

    if (username === INTERNAL_BOT) {
        return;
    }

    if (await accountIsBotBouncerApp(username)) {
        return;
    }

    const currentStatus = await getUserStatus(username);

    if (!currentStatus) {
        const message: json2md.DataObject[] = [{ p: "This user is not currently listed in the Bot Bouncer database. This may be a general enquiry, mistaken appeal or a third party appeal from another sub's mods." }];
        const user = await getUserExtended(username);
        if (user?.isModerator) {
            message.push({ p: "Note: This user is a subreddit moderator." });
        }

        await reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: json2md(message),
            isInternal: true,
        });
        return;
    }

    if (modmail.subject.startsWith(`Ban dispute for /u/${username}`) && (currentStatus.userStatus === UserStatus.Organic)) {
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

        await reddit.modMail.reply({
            body: json2md(message),
            conversationId: modmail.conversationId,
            isInternal: false,
            isAuthorHidden: true,
        });
        await reddit.modMail.archiveConversation(modmail.conversationId);
        return;
    }

    const recentAppealKey = `recentAppealMade~${username}`;
    const recentAppealMade = await redis.get(recentAppealKey);

    if (recentAppealMade) {
        // User has already made an appeal recently, so we should tell the user it's already being handled.
        await reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.recentAppealMade,
            conversationId: modmail.conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await reddit.modMail.archiveConversation(modmail.conversationId);
        return;
    }

    await storeKeyForAppeal(modmail.conversationId);

    if (currentStatus.userStatus !== UserStatus.Banned && currentStatus.userStatus !== UserStatus.Purged) {
        await addSummaryForUser(modmail.conversationId, username);
        // User is not banned or purged, so we should not send the "Appeal Received" message.
        return;
    }

    await storeAppealRecordsForUser(modmail);

    const user = await getUserOrUndefined(username);
    if (!user) {
        // User is not found, so we should not send the "Appeal Received" message.
        await addSummaryForUser(modmail.conversationId, username);
        await reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.appealShadowbannedMessage,
            conversationId: modmail.conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await reddit.modMail.archiveConversation(modmail.conversationId);
        return;
    }

    const appealOutcomeType = await handleAppeal(modmail, currentStatus);

    if (appealOutcomeType !== AppealOutcomeType.AppealGranted) {
        await addSummaryForUser(modmail.conversationId, username);

        if (currentStatus.userStatus === UserStatus.Banned) {
            await scheduler.runJob<OpenAISummaryGatherData>({
                name: ControlSubredditJob.OpenAISummaryGather,
                data: {
                    username,
                    mode: "auto",
                    conversationId: modmail.conversationId,
                    jobGuid: crypto.randomUUID(),
                },
                runAt: addSeconds(new Date(), 5),
            });
        }
    }

    await redis.set(recentAppealKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 1) });
}

function getKeyForAppeal (conversationId: string): string {
    return `appeal~${conversationId}`;
}

async function storeKeyForAppeal (conversationId: string) {
    const key = getKeyForAppeal(conversationId);
    const existingValue = await redis.exists(key);
    if (!existingValue) {
        await redis.set(key, new Date().getTime().toString(), { expiration: addDays(new Date(), 28) });
    }
}

export async function isActiveAppeal (conversationId: string): Promise<boolean> {
    const key = getKeyForAppeal(conversationId);
    const value = await redis.get(key);
    return value !== undefined;
}

export async function deleteKeyForAppeal (conversationId: string) {
    const key = getKeyForAppeal(conversationId);
    await redis.del(key);
}

async function addSummaryForUser (conversationId: string, username: string) {
    const messageText = await getSummaryForUser(username, "modmail", conversationId);

    const modmailStrings = markdownToText(messageText);

    for (const string of modmailStrings) {
        await reddit.modMail.reply({
            body: string,
            conversationId,
            isInternal: true,
        });
    }
}

async function checkBanOnSub (modmail: ModmailMessage) {
    const checkBanRegex = /^!checkban ([A-Za-z0-9_]+)/;
    const checkBanMatch = checkBanRegex.exec(modmail.bodyMarkdown);
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!modmail.participant || !checkBanMatch || checkBanMatch.length !== 2) {
        await reddit.modMail.reply({
            body: "Invalid command format. Use `!checkban <subreddit>`.",
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const subredditName = checkBanMatch[1]!;
    const message: json2md.DataObject[] = [];
    try {
        const bannedUser = await reddit.getBannedUsers({
            subredditName,
            username: modmail.participant,
        }).all();

        const isBannedOnSub = bannedUser.length > 0;
        let banMessage = `User /u/${modmail.participant} is currently ${isBannedOnSub ? "banned" : "not banned"} on /r/${subredditName}.`;
        if (isBannedOnSub) {
            if (!bannedUser[0]?.note?.startsWith(`Banned by /u/${context.appSlug}`)) {
                banMessage += " Note: The user's ban was **not** issued by Bot Bouncer.";
            }
            if (bannedUser[0]?.daysLeft !== undefined) {
                banMessage += ` The user's ban is temporary with ${bannedUser[0].daysLeft} ${pluralize("day", bannedUser[0].daysLeft)} left.`;
            }
        }
        message.push({ p: banMessage });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isMod = await isModeratorWithCache(context.appSlug, subredditName);
        if (!isMod) {
            message.push({ p: `Bot Bouncer is not a moderator of /r/${subredditName}, so it cannot check the ban status of /u/${modmail.participant}.` });
        } else if (isForbiddenError(errorMessage)) {
            message.push({ p: `Bot Bouncer could not check whether /u/${modmail.participant} is banned on /r/${subredditName} because Reddit returned \`403 Forbidden\`, which usually means /u/bot-bouncer is on the mod list but has no permissions or is missing required permissions.` });
            message.push({ p: `Check /r/${subredditName}'s mod list, confirm /u/bot-bouncer has full moderator permissions, and then retry \`!checkban ${subredditName}\`.` });
        } else {
            message.push({ p: `An error occurred while checking the ban status of /u/${modmail.participant} on /r/${subredditName}.` });
            message.push({ blockquote: errorMessage });
        }
    }
    await reddit.modMail.reply({
        body: json2md(message),
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}

/**
 * A note to Admin reviewing this new function.
 *
 * This function unbans a user on a different subreddit to r/BotBouncer. It is *only* used in cases where
 * the user has had an appeal granted and a technical issue has prevented the ban from being lifted.
 *
 * It specifically checks to see if the user was banned by Bot Bouncer, and will not impact bans issued
 * by other Moderators.
 *
 * If this is an unacceptable use of Bot Bouncer, please let me know and I will remove this feature.
 * It will only be used sparingly.
 */
async function handleUnbanCommand (modmail: ModmailMessage) {
    const handleUnbanRegex = /^!unban ([A-Za-z0-9_]+)/;
    const unbanMatch = handleUnbanRegex.exec(modmail.bodyMarkdown);
    if (!modmail.participant || unbanMatch?.length !== 2) {
        await reddit.modMail.reply({
            body: "Invalid command format. Use `!unban <subreddit>`.",
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    const currentStatus = await getUserStatus(modmail.participant);
    if (currentStatus?.userStatus !== UserStatus.Organic) {
        await reddit.modMail.reply({
            body: `User /u/${modmail.participant} is not currently marked as human in the Bot Bouncer database, so no unban action will be taken.`,
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    const subredditName = unbanMatch[1];
    if (!subredditName) {
        await reddit.modMail.reply({
            body: "Invalid command format. Use `!unban <subreddit>`.",
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    const banInfo = await reddit.getBannedUsers({
        subredditName,
        username: modmail.participant,
    }).all().then(bannedUsers => bannedUsers.length === 0 ? undefined : bannedUsers[0]);

    if (!banInfo) {
        await reddit.modMail.reply({
            body: `User /u/${modmail.participant} is not currently banned on /r/${subredditName}. No action will be taken.`,
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    if (!banInfo.note?.startsWith(`Banned by /u/${context.appSlug}`)) {
        await reddit.modMail.reply({
            body: `User /u/${modmail.participant} is currently banned on /r/${unbanMatch[1]}, but the ban was not issued by Bot Bouncer. No action will be taken.`,
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    try {
        await reddit.unbanUser(modmail.participant, subredditName);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await reddit.modMail.reply({
            body: `An error occurred while trying to unban /u/${modmail.participant} on /r/${subredditName}.\n\nError: ${errorMessage}`,
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    await reddit.modMail.reply({
        body: `User /u/${modmail.participant} has been unbanned on /r/${subredditName}.`,
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}

function isForbiddenError (errorMessage: string): boolean {
    const normalizedError = errorMessage.toLowerCase();
    return normalizedError.includes("403") || normalizedError.includes("forbidden");
}

async function showUserHistory (modmail: ModmailMessage) {
    const regex = /^!history (\d+)/;
    const match = regex.exec(modmail.bodyMarkdown);
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!modmail.participant || !match || match.length !== 2) {
        await reddit.modMail.reply({
            body: "Invalid command format. Use `!history <number_of_items>`.",
            conversationId: modmail.conversationId,
            isInternal: true,
        });
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const numberOfItems = parseInt(match[1]!, 10);
    const userHistory = await reddit.getCommentsAndPostsByUser({
        username: modmail.participant,
        limit: numberOfItems,
        sort: "new",
    }).all();

    const message: json2md.DataObject[] = [];

    if (userHistory.length === 0) {
        message.push({ p: `No recent posts or comments found for /u/${modmail.participant}.` });
    } else {
        message.push({ p: `Showing the ${numberOfItems} most recent posts and comments by /u/${modmail.participant}:` });

        for (const item of userHistory) {
            message.push({ p: `[${isT1(item.id) ? "Comment" : "Post"}](${item.permalink}) in /r/${item.subredditName} on ${format(item.createdAt, "yyyy-MM-dd hh:mm")}` });
            if (item.body) {
                message.push({ blockquote: item.body });
            }
        }
    }

    await reddit.modMail.reply({
        body: json2md(message),
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}

function getOverrideKeyForSetStatusCommand (conversationId: string): string {
    return `setStatusOverridValuee~${conversationId}`;
}

export async function setOverrideForSetStatusCommand (conversationId: string, username: string) {
    const overrideKey = getOverrideKeyForSetStatusCommand(conversationId);
    await redis.set(overrideKey, username, { expiration: addWeeks(new Date(), 4) });
}

async function getOverrideForSetStatusCommand (conversationId: string): Promise<string | undefined> {
    const overrideKey = getOverrideKeyForSetStatusCommand(conversationId);
    return redis.get(overrideKey);
}
