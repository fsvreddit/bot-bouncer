import { context, reddit } from "@devvit/web/server";
import { OnCommentCreateRequest, T1 } from "@devvit/web/shared";
import { CONTROL_SUBREDDIT } from "../constants";
import { fixCommentTriggerEvent } from "@fsvreddit/fsv-devvit-web-helpers";
import { getUserStatus } from "../dataStore";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import json2md from "json2md";

export async function handleControlSubCommentCreate (event: OnCommentCreateRequest) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleControlSubCommentCreate should only be called for the control subreddit, check the subreddit name handling logic");
    }

    event = await fixCommentTriggerEvent(event);

    if (!event.comment?.id || !event.author?.name) {
        throw new Error("Content Create: handleControlSubCommentCreate should not be called with missing comment or author information");
    }

    if (event.author.name === context.appSlug) {
        return;
    }

    const userStatus = await getUserStatus(event.author.name);

    if (userStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    await reddit.remove(event.comment.id as T1, false);

    const replyText: json2md.DataObject[] = [
        { p: "You are currently marked as **banned** on /r/BotBouncer." },
        { p: `To appeal your ban, please [message the moderators](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}) if you have not already done so.` },
        { p: "*This is an automated message.*" },
    ];

    const newComment = await reddit.submitComment({
        id: event.comment.id as T1,
        text: json2md(replyText),
    });

    await newComment.distinguish();
    await newComment.lock();

    console.log(`CommentCreate: Removed comment by banned user ${event.author.name} in ${CONTROL_SUBREDDIT}`);
}
