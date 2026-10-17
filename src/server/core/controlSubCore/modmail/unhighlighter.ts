import { context, reddit, redis } from "@devvit/web/server";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { CONTROL_SUBREDDIT, getUserStatus, ModmailMessage } from "../..";
import { addMinutes, addSeconds } from "date-fns";
import pluralize from "pluralize";

const HIGHLIGHTED_CONVERSATION_QUEUE = "highlightedConversationQueue";

export async function handleHighlightedModmail (modmail: ModmailMessage) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("handleHighlightedModmail should only be called for the control subreddit");
    }

    if (!modmail.isHighlighted) {
        return;
    }

    if (!modmail.participant) {
        return;
    }

    await redis.zAdd(HIGHLIGHTED_CONVERSATION_QUEUE, { member: modmail.conversationId, score: addMinutes(new Date(), 1).getTime() });
}

export async function processHighlightedModmailQueue () {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("processHighlightedModmailQueue should only be called for the control subreddit");
    }

    const dueEntries = await redis.zRange(HIGHLIGHTED_CONVERSATION_QUEUE, 0, Date.now(), { by: "score" });
    const runLimit = addSeconds(new Date(), 10);

    let processed = 0;

    while (dueEntries.length > 0 && new Date() < runLimit) {
        const firstEntry = dueEntries.shift();
        if (!firstEntry) {
            break;
        }

        await redis.zRem(HIGHLIGHTED_CONVERSATION_QUEUE, [firstEntry.member]);
        processed++;

        try {
            const conversationResponse = await reddit.modMail.getConversation({ conversationId: firstEntry.member });

            if (!conversationResponse.conversation?.isHighlighted || !conversationResponse.conversation.participant?.name) {
                continue;
            }

            const currentStatus = await getUserStatus(conversationResponse.conversation.participant.name);
            if (!currentStatus) {
                continue;
            }

            if (conversationResponse.conversation.state?.toLowerCase() === "archived" && (currentStatus.userStatus === UserStatus.Organic)) {
                await reddit.modMail.unhighlightConversation(firstEntry.member);
                console.log(`Unhighighter: Unhighlighted conversation ${firstEntry.member} because it is archived and the appeal was granted.`);
                continue;
            }

            await redis.zAdd(HIGHLIGHTED_CONVERSATION_QUEUE, { member: firstEntry.member, score: addMinutes(new Date(), 5).getTime() });
        } catch {
            console.error(`Failed to handle highlighted modmail conversation ${firstEntry.member}`);
        }
    }

    console.log(`Unhighlighter: Processed ${processed} highlighted modmail ${pluralize("conversation", processed)}.`);
}
