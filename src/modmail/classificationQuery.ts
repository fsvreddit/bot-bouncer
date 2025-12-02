import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { setOverrideForSetStatusCommand } from "./controlSubModmail.js";

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

    const message: MarkdownEntry[] = [
        { p: `Hi ${queryData.submittingUser}, thanks for querying the status of ${queryData.username}.` },
        { p: "A mod of /r/BotBouncer will review your query and get back to you shortly." },
        { p: "Here is the reason you provided:" },
        { blockquote: queryData.message.trim() },
    ];

    const subject = `Your classification status query about /u/${queryData.username}`;

    const conversationResponse = await context.reddit.modMail.createConversation({
        subredditName: CONTROL_SUBREDDIT,
        subject,
        to: queryData.submittingUser,
        body: tsMarkdown(message),
    });

    if (conversationResponse.conversation.id) {
        await setOverrideForSetStatusCommand(conversationResponse.conversation.id, queryData.username, context);

        const userSummary = await getSummaryForUser(queryData.username, "modmail", context);

        await context.reddit.modMail.reply({
            conversationId: conversationResponse.conversation.id,
            body: tsMarkdown(userSummary),
            isInternal: true,
        });
    }

    console.log(`Classification Queries: Handled classification query for /u/${queryData.username} from /u/${queryData.submittingUser}, conversation ID: ${conversationResponse.conversation.id}`);
}
