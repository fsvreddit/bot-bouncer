import { TriggerContext } from "@devvit/public-api";
import { ModmailMessage } from "./modmail.js";
import { compareDesc, format } from "date-fns";
import json2md from "json2md";
import _ from "lodash";

function getAppealHashKeyForUser (username: string): string {
    return `appealRecords~${username}`;
}

interface AppealEntry {
    conversationId: string;
    createdAt: number;
    subject: string;
}

function normalisedConversationId (conversationId: string): string {
    return conversationId.replace("ModmailConversation_", "");
}

export async function storeAppealRecordsForUser (modmail: ModmailMessage, context: TriggerContext) {
    const conversationId = normalisedConversationId(modmail.conversationId);

    if (!modmail.participant) {
        console.log(`No participant found for modmail conversation ${conversationId}. Cannot store appeal records.`);
        return;
    }

    const appealEntry: AppealEntry = {
        conversationId,
        createdAt: modmail.createdAt.getTime(),
        subject: modmail.subject,
    };

    await context.redis.hSetNX(getAppealHashKeyForUser(modmail.participant), conversationId, JSON.stringify(appealEntry));
}

export async function deleteAppealRecordsForUser (username: string, context: TriggerContext) {
    await context.redis.del(getAppealHashKeyForUser(username));
}

export async function getAppealTextForUser (username: string, triggerConversationId: string, context: TriggerContext): Promise<json2md.DataObject[] | undefined> {
    const appealRecordsForUser = await context.redis.hGetAll(getAppealHashKeyForUser(username));

    const appealRecords = _.compact(Object.values(appealRecordsForUser).map((value) => {
        const parsedRecord = JSON.parse(value) as AppealEntry;
        if (parsedRecord.conversationId === normalisedConversationId(triggerConversationId)) {
            return;
        }

        return {
            conversationId: parsedRecord.conversationId,
            createdAt: new Date(parsedRecord.createdAt),
            subject: parsedRecord.subject,
        };
    }));

    if (appealRecords.length === 0) {
        return;
    }

    const results: json2md.DataObject[] = [
        { h2: "Previous appeals" },
    ];

    appealRecords.sort((a, b) => compareDesc(a.createdAt, b.createdAt));

    results.push({ ul: appealRecords.map(record => `${format(record.createdAt, "yyyy-MM-dd")} - [${record.subject}](https://www.reddit.com/mail/all/${record.conversationId})`) });

    return results;
}
