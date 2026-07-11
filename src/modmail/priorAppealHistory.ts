import type { TriggerContext } from "@devvit/public-api";
import { addDays, addMinutes } from "date-fns";
import json2md from "json2md";
import { UserStatus } from "../dataStore.js";
import type { UserDetails } from "../dataStore.js";
import type { ControlSubSettings } from "../settings.js";
import type { ModmailMessage } from "./modmail.js";

const MAX_PRIOR_APPEALS_TO_SHOW = 5;
const PRIOR_APPEAL_NOTICE_LOCK_MINUTES = 10;
const SECONDS_PER_DAY = 24 * 60 * 60;

export interface PriorAppealRecord {
    username: string;
    receivedAt: number;
    conversationId: string;
    userStatusAtAppeal: UserStatus.Banned | UserStatus.Purged;
    appealedSubreddit?: string;
    banDate?: number;
}

export function getPriorAppealHistoryWarningDays (settings: ControlSubSettings): number | undefined {
    if (!settings.priorAppealHistoryWarningDays || settings.priorAppealHistoryWarningDays <= 0) {
        return undefined;
    }

    return settings.priorAppealHistoryWarningDays;
}

function normalizeUsername (username: string): string {
    return username.toLowerCase();
}

function getPriorAppealHistoryIndexKey (username: string): string {
    return `priorAppealHistoryIndex~${normalizeUsername(username)}`;
}

function getPriorAppealRecordKey (conversationId: string): string {
    return `priorAppealHistoryRecord~${conversationId}`;
}

function getPriorAppealHistoryNoticeKey (conversationId: string): string {
    return `priorAppealHistoryNotice~${conversationId}`;
}

function getPriorAppealHistoryNoticeLockKey (conversationId: string): string {
    return `priorAppealHistoryNoticeLock~${conversationId}`;
}

function getAppealedSubredditFromSubject (subject: string): string | undefined {
    const match = /\bon\s+\/r\/([A-Za-z0-9_]+)/i.exec(subject);
    return match?.[1];
}

function formatUtcDate (timestamp: number | undefined): string {
    if (!timestamp) {
        return "unknown date";
    }

    return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function getConversationLink (conversationId: string): string {
    return `https://mod.reddit.com/mail/all/${conversationId}`;
}

export function parsePriorAppealRecord (recordData: string | undefined): PriorAppealRecord | undefined {
    if (!recordData) {
        return;
    }

    try {
        const record = JSON.parse(recordData) as unknown;
        if (!record || typeof record !== "object") {
            return;
        }

        const candidate = record as Partial<PriorAppealRecord>;
        if (typeof candidate.username !== "string"
            || typeof candidate.receivedAt !== "number"
            || !Number.isFinite(candidate.receivedAt)
            || typeof candidate.conversationId !== "string"
            || (candidate.userStatusAtAppeal !== UserStatus.Banned && candidate.userStatusAtAppeal !== UserStatus.Purged)
            || (candidate.appealedSubreddit !== undefined && typeof candidate.appealedSubreddit !== "string")
            || (candidate.banDate !== undefined && (typeof candidate.banDate !== "number" || !Number.isFinite(candidate.banDate)))) {
            return;
        }

        return candidate as PriorAppealRecord;
    } catch {
        return;
    }
}

export async function getRecentPriorAppeals (
    username: string,
    warningDays: number,
    currentConversationId: string,
    context: TriggerContext,
): Promise<PriorAppealRecord[]> {
    const normalizedUsername = normalizeUsername(username);
    const indexKey = getPriorAppealHistoryIndexKey(normalizedUsername);
    const cutoff = addDays(new Date(), -warningDays).getTime();

    await context.redis.zRemRangeByScore(indexKey, 0, cutoff - 1);
    const indexedRecords = await context.redis.zRange(indexKey, cutoff, Date.now(), { by: "score", reverse: true });

    const invalidConversationIds: string[] = [];
    const records: PriorAppealRecord[] = [];
    for (const indexedRecord of indexedRecords) {
        const record = parsePriorAppealRecord(await context.redis.get(getPriorAppealRecordKey(indexedRecord.member)));
        if (!record
            || normalizeUsername(record.username) !== normalizedUsername
            || record.conversationId !== indexedRecord.member
            || record.receivedAt < cutoff) {
            invalidConversationIds.push(indexedRecord.member);
            continue;
        }

        if (record.conversationId !== currentConversationId) {
            records.push(record);
        }
    }

    if (invalidConversationIds.length > 0) {
        await context.redis.zRem(indexKey, invalidConversationIds);
    }

    return records
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, MAX_PRIOR_APPEALS_TO_SHOW);
}

export async function recordPriorAppealSubmission (
    modmail: ModmailMessage,
    userDetails: UserDetails,
    settings: ControlSubSettings,
    context: TriggerContext,
): Promise<void> {
    const username = modmail.participant;
    if (!username || (userDetails.userStatus !== UserStatus.Banned && userDetails.userStatus !== UserStatus.Purged)) {
        return;
    }

    const warningDays = getPriorAppealHistoryWarningDays(settings);
    if (!warningDays) {
        return;
    }

    const recordKey = getPriorAppealRecordKey(modmail.conversationId);
    const candidateRecord: PriorAppealRecord = {
        username: normalizeUsername(username),
        receivedAt: Date.now(),
        conversationId: modmail.conversationId,
        userStatusAtAppeal: userDetails.userStatus,
        appealedSubreddit: getAppealedSubredditFromSubject(modmail.subject),
        banDate: userDetails.reportedAt ?? userDetails.lastUpdate,
    };

    await context.redis.set(recordKey, JSON.stringify(candidateRecord), {
        nx: true,
        expiration: addDays(new Date(), warningDays),
    });

    const storedRecord = parsePriorAppealRecord(await context.redis.get(recordKey));
    if (!storedRecord || normalizeUsername(storedRecord.username) !== normalizeUsername(username)) {
        console.warn(`Prior Appeal History: Could not read a valid record for conversation ${modmail.conversationId}.`);
        return;
    }

    const indexKey = getPriorAppealHistoryIndexKey(username);
    await context.redis.zAdd(indexKey, {
        member: storedRecord.conversationId,
        score: storedRecord.receivedAt,
    });
    await context.redis.expire(indexKey, warningDays * SECONDS_PER_DAY);
}

async function releaseNoticeLock (lockKey: string, token: string, context: TriggerContext): Promise<void> {
    if (await context.redis.get(lockKey) === token) {
        await context.redis.del(lockKey);
    }
}

export async function addPriorAppealHistoryNotice (
    modmail: ModmailMessage,
    settings: ControlSubSettings,
    context: TriggerContext,
): Promise<void> {
    const username = modmail.participant;
    if (!username) {
        return;
    }

    const warningDays = getPriorAppealHistoryWarningDays(settings);
    if (!warningDays) {
        return;
    }

    const noticeKey = getPriorAppealHistoryNoticeKey(modmail.conversationId);
    if (await context.redis.exists(noticeKey)) {
        return;
    }

    const lockKey = getPriorAppealHistoryNoticeLockKey(modmail.conversationId);
    const token = `${Date.now()}:${Math.random()}`;
    await context.redis.set(lockKey, token, {
        nx: true,
        expiration: addMinutes(new Date(), PRIOR_APPEAL_NOTICE_LOCK_MINUTES),
    });

    if (await context.redis.get(lockKey) !== token) {
        return;
    }

    try {
        if (await context.redis.exists(noticeKey)) {
            return;
        }

        const recentRecords = await getRecentPriorAppeals(username, warningDays, modmail.conversationId, context);
        if (recentRecords.length === 0) {
            return;
        }

        const appealBullets = recentRecords.map((record) => {
            const appealedSubreddit = record.appealedSubreddit ? `/r/${record.appealedSubreddit}` : "unknown subreddit";
            return `${formatUtcDate(record.receivedAt)} — ${appealedSubreddit} — account status at appeal: ${record.userStatusAtAppeal} — ban recorded: ${formatUtcDate(record.banDate)} — ${getConversationLink(record.conversationId)}`;
        });

        const message: json2md.DataObject[] = [
            { p: "Prior appeal history detected." },
            { p: `/u/${username} has submitted ${recentRecords.length} previous Bot Bouncer ${recentRecords.length === 1 ? "appeal" : "appeals"} within the configured lookback window.` },
            { ul: appealBullets },
            { p: "This notice is informational only. It does not indicate whether any prior appeal was granted, denied, or resolved." },
            { p: "Appeals that receive the automated recent-appeal reply are not recorded in this history and do not receive this notice." },
        ];

        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: json2md(message),
            isInternal: true,
        });

        await context.redis.set(noticeKey, Date.now().toString(), {
            expiration: addDays(new Date(), warningDays),
        });
    } finally {
        await releaseNoticeLock(lockKey, token, context);
    }
}
