import { TriggerContext } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import json2md from "json2md";

export async function handleControlSubCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.comment?.id || !event.author?.name) {
        return;
    }

    const userStatus = await getUserStatus(event.author.name, context);

    if (userStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    await context.reddit.remove(event.comment.id, false);

    const replyText: json2md.DataObject[] = [
        { p: "You are currently marked as **banned** on /r/BotBouncer." },
        { p: `To appeal your ban, please [message the moderators](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}) if you have not already done so.` },
        { p: "*This is an automated message.*" },
    ];

    const newComment = await context.reddit.submitComment({
        id: event.comment.id,
        text: json2md(replyText),
    });

    await newComment.distinguish();
    await newComment.lock();

    console.log(`CommentCreate: Removed comment by banned user ${event.author.name} in ${CONTROL_SUBREDDIT}`);
}
