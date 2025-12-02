import { JobContext } from "@devvit/public-api";
import { isMessageId } from "@devvit/public-api/types/tid.js";
import { formatDistanceToNow } from "date-fns";
import { ControlSubSettings, getControlSubSettings } from "./settings.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
import { sendMessageToWebhook } from "./utility.js";

export async function checkUptimeAndMessages (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error("Uptime and message check is only for the control subreddit.");
        return;
    }

    const settings = await getControlSubSettings(context);
    await Promise.all([
        checkUptime(settings, context),
        checkMessages(settings, context),
    ]);
}

async function checkUptime (settings: ControlSubSettings, context: JobContext) {
    if (!settings.uptimeMonitoringEnabled) {
        console.log("Monitoring: Uptime checker is disabled.");
        return;
    }

    const webhookUrl = settings.monitoringWebhook;
    if (!webhookUrl) {
        return;
    }

    const redisKey = "existingErrorStatus";
    let errorMessage: string | undefined;
    try {
        await context.reddit.modMail.getConversations({
            subreddits: [CONTROL_SUBREDDIT],
            state: "all",
        });
        console.log("Monitoring: App appears to be working.");
        const existingState = await context.redis.get(redisKey);
        if (existingState) {
            // App was down previously. Notify that all is well.
            const downSince = new Date(parseInt(existingState));
            const messageToSend = `${context.appName} is back up! Approximate downtime: ${formatDistanceToNow(downSince)}`;
            await sendMessageToWebhook(webhookUrl, messageToSend);
            await context.redis.del(redisKey);
        }
        return;
    } catch (error) {
        errorMessage = JSON.stringify(error);
        console.log("Monitoring: Error reading modmails.");
    }

    // Is the error message anything other than a 403 Forbidden? If it is, it's likely to be platform trouble, so no need to alert.
    if (!errorMessage.includes("403 Forbidden")) {
        console.log("Monitoring: Error is not a 403 Forbidden error.");
        return;
    }

    // If we get here, we encountered an error retrieving modmails
    const existingState = await context.redis.get(redisKey);
    if (existingState) {
        const downSince = new Date(parseInt(existingState));
        console.log(`Monitoring: App was already down. Downtime duration: ${formatDistanceToNow(downSince)}`);
        return;
    }

    // App is newly down. Send a Discord notification if webhook is defined
    const messageToSend = `${context.appName} appears to be down! A 403 Forbidden error was encountered when checking modmail.`;
    await sendMessageToWebhook(webhookUrl, messageToSend);

    await context.redis.set(redisKey, new Date().getTime().toString());
}

async function checkMessages (settings: ControlSubSettings, context: JobContext) {
    const messagesProcessedKey = "messagesProcessed";
    console.log("Checking messages for uptime checker.");
    if (!settings.messageMonitoringEnabled) {
        console.log("Monitoring: Uptime checker is disabled.");
        return;
    }

    const webhookUrl = settings.monitoringWebhook;
    if (!webhookUrl) {
        console.log("Monitoring: No webhook URL defined.");
        return;
    }

    const messagesListing = await context.reddit.getMessages({
        type: "unread",
        pageSize: 100,
    });

    console.log("Read messages");

    const processedItems = await context.redis.hGetAll(messagesProcessedKey);

    const messages = (await messagesListing.all()).filter(message => isMessageId(message.id) && !processedItems[message.id]);
    console.log("Processed listing");
    if (messages.length === 0) {
        console.log("No new messages to process.");
        return;
    }

    for (const message of messages) {
        await context.redis.hSet(messagesProcessedKey, { [message.id]: "true" });
        if (message.from.type !== "user") {
            continue;
        }

        if (message.from.username !== "reddit") {
            continue;
        }

        if (message.body.startsWith("gadzooks")) {
            continue;
        }

        const alertMessage: MarkdownEntry[] = [
            { p: `Uh-oh! ${context.appName} has a message from Reddit Admin in the inbox, sent at ${message.created.toUTCString()}.` },
            { blockquote: message.body },
        ];

        let markdown = tsMarkdown(alertMessage);
        if (markdown.length > 2000) {
            markdown = markdown.substring(0, 1997) + "...";
        }
        console.log(alertMessage);
        await sendMessageToWebhook(webhookUrl, markdown);
        console.log(`Sent message to webhook for ${message.id}.`);
    }
}
