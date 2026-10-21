import { GetConversationResponse, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { CONFIGURATION_DEFAULTS, ControlSubredditJob, ModmailMessage } from "../..";
import { addMinutes, addSeconds } from "date-fns";
import { deleteKeyForAppeal, isActiveAppeal } from ".";
import { ModmailArchiverJobData } from "../../../tasks";

const KNOWN_CONVERSATIONS_KEY = "modmailArchiverKnownConversations";
const CONVERSATIONS_TO_CHECK_QUEUE = "modmailArchiverConversationsToCheckQueue";

export async function addConversationToModmailArchiverQueue (modmail: ModmailMessage) {
    if (!modmail.participant || modmail.messageAuthor !== modmail.participant) {
        return;
    }

    if (await redis.zScore(KNOWN_CONVERSATIONS_KEY, modmail.conversationId) !== undefined) {
        return;
    }

    await redis.zAdd(KNOWN_CONVERSATIONS_KEY, { member: modmail.conversationId, score: Date.now() });
}

export async function handleModmailArchiver (event: TaskRequest<ModmailArchiverJobData>) {
    if (await hasEventBeenHandled(`job:${event.data.jobGuid}`)) {
        console.warn(`Modmail Archiver: Skipping job ${event.data.jobGuid} because it has already been handled.`);
        return;
    }

    const recentlyRunKey = "modmailArchiverRecentlyRun";

    if (event.data.firstRun) {
        if (await redis.exists(recentlyRunKey)) {
            console.warn("Modmail Archiver: Skipping first run because it has already been run recently.");
            return;
        }

        await redis.del(CONVERSATIONS_TO_CHECK_QUEUE);

        const conversationsToCheck = await redis.zRange(KNOWN_CONVERSATIONS_KEY, 0, -1);

        if (conversationsToCheck.length > 0) {
            await redis.zAdd(CONVERSATIONS_TO_CHECK_QUEUE, ...conversationsToCheck);
        }

        console.log(`Modmail Archiver: First run completed. Added ${conversationsToCheck.length} conversations to the queue.`);

        await scheduler.runJob<ModmailArchiverJobData>({
            name: ControlSubredditJob.ModmailArchiver,
            data: {
                jobGuid: crypto.randomUUID(),
                firstRun: false,
            },
            runAt: addSeconds(new Date(), 5),
        });

        return;
    }

    await redis.set(recentlyRunKey, Date.now().toString(), { expiration: addMinutes(new Date(), 3) });

    const runLimit = addSeconds(new Date(), 15);
    const conversationsToCheck = await redis.zRange(CONVERSATIONS_TO_CHECK_QUEUE, 0, -1).then(entries => entries.map(entry => entry.member));
    let processed = 0;

    while (conversationsToCheck.length > 0 && new Date() < runLimit) {
        const conversationId = conversationsToCheck.shift();
        if (!conversationId) {
            break;
        }

        processed++;

        await redis.zRem(CONVERSATIONS_TO_CHECK_QUEUE, [conversationId]);

        const conversation = await reddit.modMail.getConversation({ conversationId });

        if (!conversation.conversation) {
            console.warn(`Modmail Archiver: Conversation ${conversationId} not found. Removing from known conversations.`);
            continue;
        }

        if (conversation.conversation.state?.toLowerCase() === "archived") {
            await redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
        }

        if (conversation.conversation.participant?.isDeleted) {
            await reddit.modMail.archiveConversation(conversationId);
            await redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
            console.log(`Modmail Archiver: Archived conversation ${conversationId} because the participant is deleted.`);
        }

        if (conversation.conversation.isInternal) {
            await redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
        }

        if (conversation.user?.isShadowBanned || conversation.user?.isSuspended) {
            await handleSuspendedUser(conversationId, conversation);
            await redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
        }
    }

    if (conversationsToCheck.length > 0) {
        await scheduler.runJob<ModmailArchiverJobData>({
            name: ControlSubredditJob.ModmailArchiver,
            data: {
                jobGuid: crypto.randomUUID(),
                firstRun: false,
            },
            runAt: addSeconds(new Date(), 5),
        });

        console.log(`Modmail Archiver: Processed ${processed} conversations. ${conversationsToCheck.length} conversations remain in the queue. Scheduled another run.`);
        return;
    }

    console.log(`Modmail Archiver: Processed ${processed} conversations. No more conversations remain in the queue.`);
}

async function handleSuspendedUser (conversationId: string, conversation: GetConversationResponse) {
    if (!conversation.conversation?.id) {
        return;
    }

    // Only act on a conversation that hasn't been responded to by a human yet.
    if (!await isActiveAppeal(conversationId)) {
        return;
    }

    await reddit.modMail.reply({
        body: CONFIGURATION_DEFAULTS.appealShadowbannedMessage,
        conversationId: conversation.conversation.id,
        isInternal: false,
        isAuthorHidden: false,
    });
    await reddit.modMail.archiveConversation(conversation.conversation.id);

    await deleteKeyForAppeal(conversation.conversation.id);

    console.log(`Modmail Archiver: Replied to and archived ${conversation.conversation.id} because the participant is suspended or shadowbanned.`);
}
