import { JobContext, TriggerContext } from "@devvit/public-api";
import { addDays, addHours, eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import json2md from "json2md";

const CONFIG_SESSION_GAP_MS = 60 * 60 * 1000;
const METRICS = ["appeals", "classifications", "configSessions", "bulkAccounts"] as const;
type ModeratorActivityMetric = typeof METRICS[number];

type StatisticsContext = JobContext | TriggerContext;

interface ModeratorActivityRow {
    username: string;
    appeals: number;
    classifications: number;
    configSessions: number;
    bulkAccounts: number;
}

function appealKeyForDate (date = new Date()): string {
    return `appealStatistics~${format(date, "yyyy-MM-dd")}`;
}

function classificationKeyForDate (date = new Date()): string {
    return `classificationStatistics-${format(date, "yyyy-MM-dd")}`;
}

function moderatorActivityKeyForDate (metric: ModeratorActivityMetric, date = new Date()): string {
    return `moderatorActivityStatistics:${metric}:${format(date, "yyyy-MM-dd")}`;
}

function getConfigLastEditKey (username: string): string {
    return `moderatorActivityStatistics:configLastEdit:${username}`;
}

function getBulkSubmissionSourceKey (sourceId: string, username: string): string {
    return `moderatorActivityStatistics:bulkSubmissionSource:${sourceId}:${username}`;
}

function shouldCountUsername (username: string | undefined, context: StatisticsContext): username is string {
    return Boolean(username && username !== "unknown" && username !== context.appSlug);
}

export async function recordConfigEditSession (username: string | undefined, context: StatisticsContext) {
    if (!shouldCountUsername(username, context)) {
        return;
    }

    const now = Date.now();
    const lastEditRaw = await context.redis.get(getConfigLastEditKey(username));
    const lastEdit = lastEditRaw ? parseInt(lastEditRaw) : undefined;

    if (!lastEdit || Number.isNaN(lastEdit) || now - lastEdit > CONFIG_SESSION_GAP_MS) {
        const sessions = await context.redis.zIncrBy(moderatorActivityKeyForDate("configSessions"), username, 1);
        console.log(`Moderator Activity Statistics: Counted config session for ${username}. Total sessions today: ${sessions}`);
    }

    await context.redis.set(getConfigLastEditKey(username), now.toString(), { expiration: addDays(new Date(), 2) });
}

export async function recordBulkSubmittedAccounts (username: string | undefined, accountCount: number, sourceId: string, context: StatisticsContext) {
    if (!shouldCountUsername(username, context) || accountCount <= 0) {
        return;
    }

    const dedupeKey = getBulkSubmissionSourceKey(sourceId, username);
    if (await context.redis.exists(dedupeKey)) {
        return;
    }

    await context.redis.set(dedupeKey, "true", { expiration: addDays(new Date(), 30) });
    const submitted = await context.redis.zIncrBy(moderatorActivityKeyForDate("bulkAccounts"), username, accountCount);
    console.log(`Moderator Activity Statistics: Counted ${accountCount} bulk submitted accounts for ${username}. Total submitted today: ${submitted}`);
}

function emptyRow (username: string): ModeratorActivityRow {
    return {
        username,
        appeals: 0,
        classifications: 0,
        configSessions: 0,
        bulkAccounts: 0,
    };
}

function addScore (rows: Map<string, ModeratorActivityRow>, username: string, metric: ModeratorActivityMetric, score: number) {
    if (!rows.has(username)) {
        rows.set(username, emptyRow(username));
    }

    const row = rows.get(username);
    if (!row) {
        return;
    }

    row[metric] += score;
}

async function addScoresFromKey (rows: Map<string, ModeratorActivityRow>, key: string, metric: ModeratorActivityMetric, context: JobContext) {
    const entries = await context.redis.zRange(key, 0, -1);
    for (const { member, score } of entries) {
        addScore(rows, member, metric, score);
    }
}

async function getRowsForDates (dates: Date[], context: JobContext): Promise<ModeratorActivityRow[]> {
    const rows = new Map<string, ModeratorActivityRow>();

    await Promise.all(dates.flatMap(date => [
        addScoresFromKey(rows, appealKeyForDate(date), "appeals", context),
        addScoresFromKey(rows, classificationKeyForDate(date), "classifications", context),
        addScoresFromKey(rows, moderatorActivityKeyForDate("configSessions", date), "configSessions", context),
        addScoresFromKey(rows, moderatorActivityKeyForDate("bulkAccounts", date), "bulkAccounts", context),
    ]));

    return Array.from(rows.values()).sort((a, b) => {
        const totalA = a.appeals + a.classifications + a.configSessions + a.bulkAccounts;
        const totalB = b.appeals + b.classifications + b.configSessions + b.bulkAccounts;
        if (totalA !== totalB) {
            return totalB - totalA;
        }
        return a.username.localeCompare(b.username);
    });
}

function formatNumber (value: number): string {
    return value.toLocaleString();
}

function addActivityTable (wikiContent: json2md.DataObject[], rows: ModeratorActivityRow[], emptyMessage: string) {
    if (rows.length === 0) {
        wikiContent.push({ p: emptyMessage });
        return;
    }

    wikiContent.push({
        table: {
            headers: ["Username", "Appeals", "Classifications", "Config sessions", "Bulk accounts submitted"],
            rows: rows.map(row => [
                `/u/${row.username}`,
                formatNumber(row.appeals),
                formatNumber(row.classifications),
                formatNumber(row.configSessions),
                formatNumber(row.bulkAccounts),
            ]),
        },
    });
}

export async function updateModeratorActivityStatistics (context: JobContext) {
    const runRecentlyKey = "moderatorActivityStatisticsRunRecently";
    if (await context.redis.exists(runRecentlyKey)) {
        return;
    }
    await context.redis.set(runRecentlyKey, Date.now().toString(), { expiration: addHours(new Date(), 1) });

    const startDate = startOfDay(subDays(new Date(), 7));
    const endDate = startOfDay(subDays(new Date(), 1));
    const dayToDelete = subDays(new Date(), 8);
    const allDaysInRange = eachDayOfInterval({ start: startDate, end: endDate });

    await Promise.all(METRICS.map(metric => context.redis.del(moderatorActivityKeyForDate(metric, dayToDelete))));

    const weekRows = await getRowsForDates(allDaysInRange, context);
    const yesterdayRows = await getRowsForDates([subDays(new Date(), 1)], context);
    const todayRows = await getRowsForDates([new Date()], context);

    const wikiContent: json2md.DataObject[] = [
        { h1: "Moderator activity statistics" },
        { p: "This lists moderators who have handled Bot Bouncer review work or related maintenance within the last week." },
        { p: "Config work is counted by session. One config session is counted when a moderator makes one or more config revisions without a gap of more than 60 minutes between revisions." },
    ];

    addActivityTable(wikiContent, weekRows, "No moderator activity was found for the last week.");

    wikiContent.push({ h2: "Yesterday's activity (UTC)" });
    addActivityTable(wikiContent, yesterdayRows, "No moderator activity was recorded yesterday.");

    wikiContent.push({ h2: "Today's activity since midnight UTC" });
    addActivityTable(wikiContent, todayRows, "No moderator activity has been recorded today.");

    wikiContent.push({ p: "This page updates every hour, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/moderatoractivity",
        content: json2md(wikiContent),
    });
}
