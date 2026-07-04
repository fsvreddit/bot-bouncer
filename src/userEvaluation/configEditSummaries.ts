import { JobContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import _ from "lodash";
import { addHours, subDays } from "date-fns";
import pluralize from "pluralize";

const CONFIG_EDIT_SUMMARIES_KEY = "evaluatorConfigEditSummaries";
const CONFIG_EDIT_SUMMARY_JOB_QUEUED_KEY = "evaluatorConfigEditSummaryJobQueued";
const CONFIG_EDIT_SUMMARY_WIKI_PAGE = "evaluator-config-summaries";
const CONFIG_EDIT_SUMMARY_RETENTION_DAYS = 14;
const REVISION_GROUP_INACTIVITY_THRESHOLD_MS = 20 * 60 * 1000;

interface ModuleChangeSummary {
    added: number;
    removed: number;
}

export interface EvaluatorConfigEditSummary {
    timestamp: number;
    updatedBy: string;
    changes: Record<string, ModuleChangeSummary>;
    revisionReason?: string;
}

interface RecordEvaluatorConfigEditSummaryOptions {
    previousVariables: Record<string, string>;
    newVariables: Record<string, string>;
    updatedBy: string;
    updatedAt?: number;
    revisionReason?: string;
}

function parseStoredVariables (variables: Record<string, string>): Record<string, unknown> {
    return _.fromPairs(Object.entries(variables).map(([key, value]) => {
        try {
            return [key, JSON.parse(value) as unknown];
        } catch {
            return [key, value];
        }
    }));
}

function countElements (value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }

    if (_.isPlainObject(value)) {
        return Object.keys(value as Record<string, unknown>).length;
    }

    return value === undefined ? 0 : 1;
}

function countArrayChange (previousValue: unknown[], newValue: unknown[]): ModuleChangeSummary {
    const previousCounts = _.countBy(previousValue.map(item => JSON.stringify(item)));
    const newCounts = _.countBy(newValue.map(item => JSON.stringify(item)));
    const allValues = _.uniq([...Object.keys(previousCounts), ...Object.keys(newCounts)]);

    let added = 0;
    let removed = 0;
    for (const value of allValues) {
        const previousCount = previousCounts[value] ?? 0;
        const newCount = newCounts[value] ?? 0;
        if (newCount > previousCount) {
            added += newCount - previousCount;
        } else if (previousCount > newCount) {
            removed += previousCount - newCount;
        }
    }

    return { added, removed };
}

function addChange (target: ModuleChangeSummary, source: ModuleChangeSummary) {
    target.added += source.added;
    target.removed += source.removed;
}

function countObjectChange (previousValue: Record<string, unknown>, newValue: Record<string, unknown>): ModuleChangeSummary {
    const result = { added: 0, removed: 0 };
    const allKeys = _.uniq([...Object.keys(previousValue), ...Object.keys(newValue)]);

    for (const key of allKeys) {
        addChange(result, countValueChange(previousValue[key], newValue[key]));
    }

    return result;
}

function countValueChange (previousValue: unknown, newValue: unknown): ModuleChangeSummary {
    if (_.isEqual(previousValue, newValue)) {
        return { added: 0, removed: 0 };
    }

    if (previousValue === undefined) {
        return { added: countElements(newValue), removed: 0 };
    }

    if (newValue === undefined) {
        return { added: 0, removed: countElements(previousValue) };
    }

    if (Array.isArray(previousValue) && Array.isArray(newValue)) {
        return countArrayChange(previousValue, newValue);
    }

    if (_.isPlainObject(previousValue) && _.isPlainObject(newValue)) {
        return countObjectChange(previousValue as Record<string, unknown>, newValue as Record<string, unknown>);
    }

    return { added: 1, removed: 1 };
}

export function summarizeEvaluatorConfigChanges (previousVariables: Record<string, string>, newVariables: Record<string, string>): Record<string, ModuleChangeSummary> {
    const previousParsed = parseStoredVariables(previousVariables);
    const newParsed = parseStoredVariables(newVariables);
    const allVariableKeys = _.uniq([...Object.keys(previousParsed), ...Object.keys(newParsed)]).sort();
    const changes: Record<string, ModuleChangeSummary> = {};

    for (const variableKey of allVariableKeys) {
        if (variableKey === "errors") {
            continue;
        }

        const module = variableKey.split(":")[0];
        const change = countValueChange(previousParsed[variableKey], newParsed[variableKey]);
        if (change.added === 0 && change.removed === 0) {
            continue;
        }

        changes[module] ??= { added: 0, removed: 0 };
        addChange(changes[module], change);
    }

    return changes;
}

function sanitizeInlineText (input: string): string {
    return input.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatUtcTimestamp (timestamp: number): string {
    return new Date(timestamp).toISOString().substring(0, 16).replace("T", " ") + " UTC";
}

function formatUtcDate (timestamp: number): string {
    return new Date(timestamp).toISOString().substring(0, 10);
}

function formatUtcTime (timestamp: number): string {
    return new Date(timestamp).toISOString().substring(11, 16);
}

function formatGroupRange (startTimestamp: number, endTimestamp: number): string {
    if (startTimestamp === endTimestamp) {
        return formatUtcTimestamp(startTimestamp);
    }

    if (formatUtcDate(startTimestamp) === formatUtcDate(endTimestamp)) {
        return `${formatUtcDate(startTimestamp)} ${formatUtcTime(startTimestamp)}–${formatUtcTime(endTimestamp)} UTC`;
    }

    return `${formatUtcTimestamp(startTimestamp)}–${formatUtcTimestamp(endTimestamp)}`;
}

function formatModuleChange (module: string, change: ModuleChangeSummary): string | undefined {
    const parts: string[] = [];
    if (change.added > 0) {
        parts.push(`+ ${change.added}`);
    }

    if (change.removed > 0) {
        parts.push(`- ${change.removed}`);
    }

    if (parts.length === 0) {
        return;
    }

    return `${module} ${parts.join(", ")}`;
}

function ensureSentenceEnd (input: string): string {
    return /[.!?]$/.test(input) ? input : `${input}.`;
}

function formatSummaryLine (summary: EvaluatorConfigEditSummary): string {
    const changes = Object.entries(summary.changes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([module, change]) => formatModuleChange(module, change))
        .filter((value): value is string => Boolean(value))
        .join("; ");

    const revisionReason = sanitizeInlineText(summary.revisionReason ?? "No revision reason provided.");
    const changeText = changes.length > 0 ? changes : "no countable variable changes";

    return `* **${formatUtcTimestamp(summary.timestamp)}**; applied by **${sanitizeInlineText(summary.updatedBy)}**; ${changeText}. Revision reason: ${ensureSentenceEnd(revisionReason)}`;
}

function groupSummaries (summaries: EvaluatorConfigEditSummary[]): EvaluatorConfigEditSummary[][] {
    const ascending = [...summaries].sort((a, b) => a.timestamp - b.timestamp);
    const groups: EvaluatorConfigEditSummary[][] = [];

    for (const summary of ascending) {
        const currentGroup = groups[groups.length - 1];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const previousSummary = currentGroup?.[currentGroup.length - 1];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!currentGroup || !previousSummary || summary.timestamp - previousSummary.timestamp > REVISION_GROUP_INACTIVITY_THRESHOLD_MS) {
            groups.push([summary]);
        } else {
            currentGroup.push(summary);
        }
    }

    return groups.reverse();
}

function pluralizeRevision (count: number): string {
    return `${count} evaluator-config ${pluralize("revision", count)}`;
}

function pluralizeModerator (count: number): string {
    return `${count} ${pluralize("moderator", count)}`;
}

export function buildEvaluatorConfigEditSummaryWikiPage (summaries: EvaluatorConfigEditSummary[], now = new Date()): string {
    const retainedSummaries = summaries
        .filter(summary => summary.timestamp >= subDays(now, CONFIG_EDIT_SUMMARY_RETENTION_DAYS).getTime())
        .sort((a, b) => b.timestamp - a.timestamp);

    const lines = [
        "# Evaluator config edit summaries",
        "",
        `This page is updated at the top of the next hour after an evaluator-config edit and shows edit summaries from the past ${CONFIG_EDIT_SUMMARY_RETENTION_DAYS} days (as of the last update).`,
        "",
        `Last updated: **${formatUtcTimestamp(now.getTime())}**`,
        "",
    ];

    if (retainedSummaries.length === 0) {
        lines.push("No evaluator-config edits have been recorded in the past 14 days.", "");
        return lines.join("\n");
    }

    const groups = groupSummaries(retainedSummaries);
    for (const group of groups) {
        const ascendingGroup = [...group].sort((a, b) => a.timestamp - b.timestamp);
        const startTimestamp = ascendingGroup[0].timestamp;
        const endTimestamp = ascendingGroup[ascendingGroup.length - 1].timestamp;
        const moderatorCount = _.uniq(group.map(summary => summary.updatedBy)).length;

        lines.push(`## Revision group: **${formatGroupRange(startTimestamp, endTimestamp)}**`);
        lines.push("");
        lines.push(`${pluralizeRevision(group.length)} by ${pluralizeModerator(moderatorCount)}.`);
        lines.push("");

        for (const summary of [...group].sort((a, b) => b.timestamp - a.timestamp)) {
            lines.push(formatSummaryLine(summary));
        }
        lines.push("");
    }

    return lines.join("\n");
}

async function loadSummaries (context: JobContext): Promise<EvaluatorConfigEditSummary[]> {
    const stored = await context.redis.get(CONFIG_EDIT_SUMMARIES_KEY);
    if (!stored) {
        return [];
    }

    try {
        return JSON.parse(stored) as EvaluatorConfigEditSummary[];
    } catch (error) {
        console.error("Evaluator Config Edit Summaries: Failed to parse stored summaries.", error);
        return [];
    }
}

async function saveSummaries (summaries: EvaluatorConfigEditSummary[], context: JobContext, now = new Date()) {
    const retainedSummaries = summaries.filter(summary => summary.timestamp >= subDays(now, CONFIG_EDIT_SUMMARY_RETENTION_DAYS).getTime());
    await context.redis.set(CONFIG_EDIT_SUMMARIES_KEY, JSON.stringify(retainedSummaries));
}

export function nextTopOfHour (now = new Date()): Date {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
}

async function queueSummaryPageUpdate (context: JobContext, now = new Date()) {
    const alreadyQueued = await context.redis.exists(CONFIG_EDIT_SUMMARY_JOB_QUEUED_KEY);
    if (alreadyQueued) {
        return;
    }

    const runAt = nextTopOfHour(now);
    await context.redis.set(CONFIG_EDIT_SUMMARY_JOB_QUEUED_KEY, runAt.toISOString(), { expiration: addHours(runAt, 1) });
    await context.scheduler.runJob({
        name: ControlSubredditJob.UpdateEvaluatorConfigEditSummaryPage,
        runAt,
    });
}

export async function recordEvaluatorConfigEditSummary (options: RecordEvaluatorConfigEditSummaryOptions, context: JobContext) {
    const changes = summarizeEvaluatorConfigChanges(options.previousVariables, options.newVariables);
    if (Object.keys(changes).length === 0) {
        console.log("Evaluator Config Edit Summaries: No countable variable changes detected; no summary recorded.");
        return;
    }

    const now = new Date();
    const summaries = await loadSummaries(context);
    summaries.push({
        timestamp: options.updatedAt ?? now.getTime(),
        updatedBy: options.updatedBy,
        changes,
        revisionReason: options.revisionReason,
    });

    await saveSummaries(summaries, context, now);
    await queueSummaryPageUpdate(context, now);
}

export async function updateEvaluatorConfigEditSummaryPage (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Evaluator Config Edit Summaries: This job should only be run in the control subreddit.");
    }

    const now = new Date();
    const summaries = await loadSummaries(context);
    await saveSummaries(summaries, context, now);

    const retainedSummaries = summaries.filter(summary => summary.timestamp >= subDays(now, CONFIG_EDIT_SUMMARY_RETENTION_DAYS).getTime());
    const content = buildEvaluatorConfigEditSummaryWikiPage(retainedSummaries, now);

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: CONFIG_EDIT_SUMMARY_WIKI_PAGE,
        content,
        reason: "Updating evaluator config edit summaries.",
    });

    await context.redis.del(CONFIG_EDIT_SUMMARY_JOB_QUEUED_KEY);
}
