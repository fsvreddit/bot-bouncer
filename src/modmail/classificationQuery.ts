import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "../constants.js";
import json2md from "json2md";
import { getSummaryForUser } from "../UserSummary/userSummary.js";

const CLASSIFICATION_QUERY_QUEUE = "classificationQueryQueue";

export interface QueryData {
    username: string;
    message: string;
    submittingUser: string;
}

export async function addClassificationQueryToQueue (queryData: QueryData, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Cannot add classification query in control subreddit");
    }

    await context.redis.global.hSet(CLASSIFICATION_QUERY_QUEUE, { [Date.now().toString()]: JSON.stringify(queryData) });
    console.log(`Classification Queries: Submitted query for /u/${queryData.username} from /u/${queryData.submittingUser}`);
}

export async function handleClassificationQueryQueue (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Cannot handle classification query queue outside of control subreddit");
    }

    const entries = await context.redis.global.hGetAll(CLASSIFICATION_QUERY_QUEUE);

    if (Object.keys(entries).length === 0) {
        return;
    }

    const [entryId, queryJson] = Object.entries(entries)[0];

    const queryData = JSON.parse(queryJson) as QueryData;

    await context.redis.global.hDel(CLASSIFICATION_QUERY_QUEUE, [entryId]);

    const message: json2md.DataObject[] = [
        { p: `Hi ${queryData.submittingUser}, thanks for querying the status of ${queryData.username}.` },
        { p: "A mod of /r/BotBouncer will review your query and get back to you shortly." },
        { p: "Here is the reason you provided:" },
        { blockquote: queryData.message.trim() },
    ];

    const subject = `Your classification status query about /u/${queryData.username}`;

    await context.reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: CONTROL_SUBREDDIT,
        to: queryData.submittingUser,
        subject,
        text: json2md(message),
    });

    const modmailMessages = await context.reddit.modMail.getConversations({
        subreddits: [CONTROL_SUBREDDIT],
        state: "all",
        sort: "recent",
        limit: 100,
    });

    const conversation = Object.entries(modmailMessages.conversations)
        .map(([id, conversation]) => ({ id, conversation }))
        .find(({ conversation }) => conversation.subject === subject && conversation.participant?.name === queryData.submittingUser);

    if (!conversation) {
        console.error("Classification Queries: Could not find modmail conversation for classification query", queryData);
        return;
    }

    const userSummary = await getSummaryForUser(queryData.username, "modmail", context);

    await context.reddit.modMail.reply({
        conversationId: conversation.id,
        body: json2md(userSummary),
        isInternal: true,
    });

    console.log(`Classification Queries: Handled classification query for /u/${queryData.username} from /u/${queryData.submittingUser}, conversation ID: ${conversation.id}`);
}
