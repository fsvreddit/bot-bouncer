import { context, reddit, redis } from "@devvit/web/server";
import { CONTROL_SUBREDDIT, isModeratorWithCache } from "../..";
import json2md from "json2md";
import { setOverrideForSetStatusCommand } from ".";
import { getSummaryForUser } from "../userSummary";

const CLASSIFICATION_QUERY_QUEUE = "classificationQueryQueue";

export interface QueryData {
    username: string;
    message: string;
    submittingUser: string;
}

export async function addClassificationQueryToQueue (queryData: QueryData) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Cannot add classification query in control subreddit");
    }

    await redis.global.hSet(CLASSIFICATION_QUERY_QUEUE, { [Date.now().toString()]: JSON.stringify(queryData) });
    console.log(`Classification Queries: Submitted query for /u/${queryData.username} from /u/${queryData.submittingUser}`);
}

export async function handleClassificationQueryQueue () {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Cannot handle classification query queue outside of control subreddit");
    }

    const entries = await redis.global.hGetAll(CLASSIFICATION_QUERY_QUEUE);

    const firstEntry = Object.entries(entries)[0];
    if (!firstEntry) {
        return;
    }

    const [entryId, queryJson] = firstEntry;

    const queryData = JSON.parse(queryJson) as QueryData;

    await redis.global.hDel(CLASSIFICATION_QUERY_QUEUE, [entryId]);

    const message: json2md.DataObject[] = [
        { p: `Hi ${queryData.submittingUser}, thanks for querying the status of ${queryData.username}.` },
        { p: "A mod of /r/BotBouncer will review your query and get back to you shortly." },
        { p: "Here is the reason you provided:" },
        { blockquote: queryData.message.trim() },
    ];

    const userIsBotBouncerMod = await isModeratorWithCache(queryData.submittingUser, CONTROL_SUBREDDIT);
    const subject = `Your classification status query about /u/${queryData.username}`;

    let conversationId: string | undefined;
    if (userIsBotBouncerMod) {
        conversationId = await reddit.modMail.createModInboxConversation({
            subredditId: context.subredditId,
            subject,
            bodyMarkdown: json2md(message),
        });
    } else {
        const conversationResponse = await reddit.modMail.createConversation({
            subredditName: CONTROL_SUBREDDIT,
            subject,
            to: queryData.submittingUser,
            body: json2md(message),
        });
        conversationId = conversationResponse.conversation.id;
    }

    if (conversationId) {
        await setOverrideForSetStatusCommand(conversationId, queryData.username);

        const userSummary = await getSummaryForUser(queryData.username, "modmail");

        await reddit.modMail.reply({
            conversationId,
            body: json2md(userSummary),
            isInternal: true,
        });
    }

    console.log(`Classification Queries: Handled classification query for /u/${queryData.username} from /u/${queryData.submittingUser}, conversation ID: ${conversationId}`);
}
