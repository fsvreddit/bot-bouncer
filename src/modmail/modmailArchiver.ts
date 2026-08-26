import { GetConversationResponse, JobContext, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";
import { addMinutes, addSeconds } from "date-fns";
import { ControlSubredditJob } from "../constants.js";
import { ModmailMessage } from "./modmail.js";
import { CONFIGURATION_DEFAULTS } from "../settings.js";
import { deleteKeyForAppeal, isActiveAppeal } from "./controlSubModmail.js";

const KNOWN_CONVERSATIONS_KEY = "modmailArchiverKnownConversations";
const CONVERSATIONS_TO_CHECK_QUEUE = "modmailArchiverConversationsToCheckQueue";

export async function addConversationToModmailArchiverQueue (modmail: ModmailMessage, context: TriggerContext) {
    if (!modmail.participant || modmail.messageAuthor !== modmail.participant) {
        return;
    }

    if (await context.redis.zScore(KNOWN_CONVERSATIONS_KEY, modmail.conversationId) !== undefined) {
        return;
    }

    await context.redis.zAdd(KNOWN_CONVERSATIONS_KEY, { member: modmail.conversationId, score: Date.now() });
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ModmailArchiverJobData = {
    jobGuid: string;
    firstRun?: boolean;
};

export async function handleModmailArchiverJob (event: ScheduledJobEvent<ModmailArchiverJobData>, context: JobContext) {
    if (await hasTriggerBeenHandled(context.redis, `job:${event.data.jobGuid}`)) {
        console.warn(`Modmail Archiver: Skipping job ${event.data.jobGuid} because it has already been handled.`);
        return;
    }

    const recentlyRunKey = "modmailArchiverRecentlyRun";

    if (event.data.firstRun) {
        if (await context.redis.exists(recentlyRunKey)) {
            console.warn("Modmail Archiver: Skipping first run because it has already been run recently.");
            return;
        }

        await context.redis.del(CONVERSATIONS_TO_CHECK_QUEUE);

        const conversationsToCheck = await context.redis.zRange(KNOWN_CONVERSATIONS_KEY, 0, -1);

        if (conversationsToCheck.length > 0) {
            await context.redis.zAdd(CONVERSATIONS_TO_CHECK_QUEUE, ...conversationsToCheck);
        }

        console.log(`Modmail Archiver: First run completed. Added ${conversationsToCheck.length} conversations to the queue.`);

        await context.scheduler.runJob<ModmailArchiverJobData>({
            name: ControlSubredditJob.ModmailArchiver,
            data: {
                jobGuid: crypto.randomUUID(),
                firstRun: false,
            },
            runAt: addSeconds(new Date(), 5),
        });

        return;
    }

    await context.redis.set(recentlyRunKey, Date.now().toString(), { expiration: addMinutes(new Date(), 3) });

    const runLimit = addSeconds(new Date(), 15);
    const conversationsToCheck = await context.redis.zRange(CONVERSATIONS_TO_CHECK_QUEUE, 0, -1).then(entries => entries.map(entry => entry.member));
    let processed = 0;

    while (conversationsToCheck.length > 0 && new Date() < runLimit) {
        const conversationId = conversationsToCheck.shift();
        if (!conversationId) {
            break;
        }

        processed++;

        await context.redis.zRem(CONVERSATIONS_TO_CHECK_QUEUE, [conversationId]);

        const conversation = await context.reddit.modMail.getConversation({ conversationId });

        if (!conversation.conversation) {
            console.warn(`Modmail Archiver: Conversation ${conversationId} not found. Removing from known conversations.`);
            continue;
        }

        if (conversation.conversation.state?.toLowerCase() === "archived") {
            console.log(`Modmail Archiver: Conversation ${conversationId} is already archived. Removing from known conversations.`);
            await context.redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
        }

        if (conversation.conversation.participant?.isDeleted) {
            await context.reddit.modMail.archiveConversation(conversationId);
            await context.redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
            console.log(`Modmail Archiver: Archived conversation ${conversationId} because the participant is deleted.`);
        }

        if (conversation.conversation.isInternal) {
            await context.redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
        }

        if (conversation.user?.isShadowBanned || conversation.user?.isSuspended) {
            await handleSuspendedUser(conversationId, conversation, context);
            await context.redis.zRem(KNOWN_CONVERSATIONS_KEY, [conversationId]);
        }
    }

    if (conversationsToCheck.length > 0) {
        await context.scheduler.runJob<ModmailArchiverJobData>({
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

async function handleSuspendedUser (conversationId: string, conversation: GetConversationResponse, context: JobContext) {
    if (!conversation.conversation?.id) {
        return;
    }

    // Only act on a conversation that hasn't been responded to by a human yet.
    if (!await isActiveAppeal(conversationId, context)) {
        return;
    }

    await context.reddit.modMail.reply({
        body: CONFIGURATION_DEFAULTS.appealShadowbannedMessage,
        conversationId: conversation.conversation.id,
        isInternal: false,
        isAuthorHidden: false,
    });
    await context.reddit.modMail.archiveConversation(conversation.conversation.id);

    await deleteKeyForAppeal(conversation.conversation.id, context);

    console.log(`Modmail Archiver: Replied to and archived ${conversation.conversation.id} because the participant is suspended or shadowbanned.`);
}
