import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined } from "../utility.js";
import { CONFIGURATION_DEFAULTS } from "../settings.js";
import { addDays, subMinutes } from "date-fns";
import json2md from "json2md";

export async function handleControlSubredditModmail (username: string, conversationId: string, isFirstMessage: boolean, subject: string | undefined, message: string | undefined, context: TriggerContext) {
    if (isFirstMessage) {
        return handleModmailFromUser(username, conversationId, subject, context);
    } else {
        return;
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

async function handleModmailFromUser (username: string, conversationId: string, subject: string | undefined, context: TriggerContext) {
    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus || currentStatus.userStatus === UserStatus.Pending) {
        return;
    }

    if (subject?.startsWith(`Ban dispute for /u/${username}`) && (currentStatus.userStatus === UserStatus.Organic || currentStatus.userStatus === UserStatus.Declined)) {
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
            conversationId,
            isInternal: false,
            isAuthorHidden: true,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return;
    }

    const recentAppealKey = `recentAppeal~${username}`;
    const recentAppealMade = await context.redis.get(recentAppealKey);

    if (recentAppealMade) {
        // User has already made an appeal recently, so we should tell the user it's already being handled.
        await context.reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.recentAppealMade,
            conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return;
    }

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
            conversationId,
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
            conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return;
    }

    await context.reddit.modMail.reply({
        body: CONFIGURATION_DEFAULTS.appealMessage,
        conversationId,
        isInternal: false,
        isAuthorHidden: false,
    });

    await context.redis.set(recentAppealKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 1) });
}
