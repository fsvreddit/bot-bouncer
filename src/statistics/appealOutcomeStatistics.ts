import { JobContext, TriggerContext } from "@devvit/public-api";
import { subDays, subHours } from "date-fns";
import json2md from "json2md";

export enum AppealTrackedOutcome {
    AutomaticDenial = "automaticDenial",
    AutomaticGrant = "automaticGrant",
}

const TRACKED_APPEAL_OUTCOME_STATISTICS_KEY = "trackedAppealOutcomeStatistics";

interface TrackedAppealOutcomeEvent {
    outcome: AppealTrackedOutcome;
    name: string;
}

interface TrackedAppealOutcomeWindow {
    label: string;
    since: Date;
}

interface TrackedAppealOutcomeSummary {
    label: string;
    automaticGrants: number;
    automaticDenials: number;
    byRule: Record<string, Record<AppealTrackedOutcome, number>>;
}

export async function markTrackedAppealOutcome (outcome: AppealTrackedOutcome, name: string, context: TriggerContext | JobContext) {
    const timestamp = Date.now();
    const event: TrackedAppealOutcomeEvent = { outcome, name };
    const uniqueMember = `${timestamp}:${Math.random()}:${JSON.stringify(event)}`;

    await context.redis.zAdd(TRACKED_APPEAL_OUTCOME_STATISTICS_KEY, { member: uniqueMember, score: timestamp });
    await context.redis.zRemRangeByScore(TRACKED_APPEAL_OUTCOME_STATISTICS_KEY, 0, subDays(new Date(), 31).getTime());
}

export async function pushTrackedAppealOutcomeStatistics (wikiContent: json2md.DataObject[], context: JobContext) {
    const windows: TrackedAppealOutcomeWindow[] = [
        { label: "Past 24 hours", since: subHours(new Date(), 24) },
        { label: "Past 7 days", since: subDays(new Date(), 7) },
        { label: "Past 30 days", since: subDays(new Date(), 30) },
    ];

    const summaries = await Promise.all(windows.map(window => getTrackedAppealOutcomeSummary(window, context)));

    wikiContent.push({ h2: "Tracked automated appeal outcomes" });
    wikiContent.push({ p: "These statistics count appeal config entries that use `trackOutcome: automaticGrant` or `trackOutcome: automaticDenial`. They help estimate how many appeals are resolved by automated appeal handling instead of manual moderator review." });

    const summaryRows = summaries.map(summary => [
        summary.label,
        summary.automaticGrants.toLocaleString(),
        summary.automaticDenials.toLocaleString(),
        (summary.automaticGrants + summary.automaticDenials).toLocaleString(),
    ]);

    wikiContent.push({ table: {
        headers: ["Window", "Automatic grants", "Automatic denials", "Total tracked automated actions"],
        rows: summaryRows,
    } });

    const ruleRows = summaries.flatMap(summary => Object.entries(summary.byRule).flatMap(([name, outcomeCounts]) => [
        [summary.label, formatOutcome(AppealTrackedOutcome.AutomaticGrant), name, (outcomeCounts[AppealTrackedOutcome.AutomaticGrant] ?? 0).toLocaleString()],
        [summary.label, formatOutcome(AppealTrackedOutcome.AutomaticDenial), name, (outcomeCounts[AppealTrackedOutcome.AutomaticDenial] ?? 0).toLocaleString()],
    ])).filter(([, , , count]) => count !== "0");

    if (ruleRows.length > 0) {
        wikiContent.push({ h3: "Tracked automated outcomes by config" });
        wikiContent.push({ table: {
            headers: ["Window", "Outcome", "Appeal config", "Count"],
            rows: ruleRows,
        } });
    }
}

async function getTrackedAppealOutcomeSummary (window: TrackedAppealOutcomeWindow, context: JobContext): Promise<TrackedAppealOutcomeSummary> {
    const entries = await context.redis.zRange(TRACKED_APPEAL_OUTCOME_STATISTICS_KEY, window.since.getTime(), Date.now(), { by: "score" });

    const summary: TrackedAppealOutcomeSummary = {
        label: window.label,
        automaticGrants: 0,
        automaticDenials: 0,
        byRule: {},
    };

    for (const entry of entries) {
        const event = parseTrackedAppealOutcomeEvent(entry.member);
        if (!event) {
            continue;
        }

        if (event.outcome === AppealTrackedOutcome.AutomaticGrant) {
            summary.automaticGrants++;
        }

        if (event.outcome === AppealTrackedOutcome.AutomaticDenial) {
            summary.automaticDenials++;
        }

        summary.byRule[event.name] ??= {
            [AppealTrackedOutcome.AutomaticGrant]: 0,
            [AppealTrackedOutcome.AutomaticDenial]: 0,
        };
        summary.byRule[event.name][event.outcome]++;
    }

    return summary;
}

function parseTrackedAppealOutcomeEvent (member: string): TrackedAppealOutcomeEvent | undefined {
    const jsonStart = member.indexOf("{");
    if (jsonStart === -1) {
        return;
    }

    try {
        const parsed = JSON.parse(member.slice(jsonStart)) as Partial<TrackedAppealOutcomeEvent>;
        if (!parsed.name || !parsed.outcome || !Object.values(AppealTrackedOutcome).includes(parsed.outcome)) {
            return;
        }

        return {
            name: parsed.name,
            outcome: parsed.outcome,
        };
    } catch {
        return;
    }
}

function formatOutcome (outcome: AppealTrackedOutcome): string {
    switch (outcome) {
        case AppealTrackedOutcome.AutomaticGrant:
            return "Automatic grant";
        case AppealTrackedOutcome.AutomaticDenial:
            return "Automatic denial";
    }
}
