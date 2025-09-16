import { JobContext, UserSocialLink } from "@devvit/public-api";
import { format, subWeeks } from "date-fns";
import json2md from "json2md";
import { max, min, uniq } from "lodash";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { SOCIAL_LINKS_STORE, UserDetails, UserStatus } from "../dataStore.js";
import { StatsUserEntry } from "../sixHourlyJobs.js";

export function cleanLink (input: string): string {
    if (!input.includes("onlyfans.com") && !input.includes("fans.ly") && !input.includes("fans.ly")) {
        return input;
    }

    let newString = input;
    if (newString.startsWith("https://www.")) {
        newString = newString.replace("https://www.", "https://");
    }

    if (newString.startsWith("https://onlyfans.com/action/trial")) {
        return newString;
    }

    const linkRegex = /(https:\/\/(?:onlyfans\.com|fansly\.com|fans\.ly)\/[\w\d]+\/)(?:[ct]\d+|trial)/;
    const matches = linkRegex.exec(newString);
    if (matches?.[1]) {
        newString = matches[1];
    }

    if (!newString.endsWith("/")) {
        newString += "/";
    }
    return newString;
}

type UserDetailsWithSocialLink = UserDetails & { socialLinks?: string[] };

interface SocialLinksEntry {
    hits: number;
    coveredByEvaluator: boolean;
    firstSeen?: Date;
    lastSeen?: Date;
    usernames: string[];
}

export async function updateSocialLinksStatistics (allEntries: StatsUserEntry[], context: JobContext) {
    let recentData = allEntries
        .map(item => ({ username: item.username, data: item.data as UserDetailsWithSocialLink }))
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 4))
        .filter(item => item.data.userStatus === UserStatus.Banned || item.data.lastStatus === UserStatus.Banned);

    const socialLinks = await context.redis.hMGet(SOCIAL_LINKS_STORE, recentData.map(item => item.username));

    for (let i = 0; i < recentData.length; i++) {
        const socialLinksEntry = socialLinks[i];
        if (!socialLinksEntry) {
            continue;
        }

        const userSocialLinks = JSON.parse(socialLinksEntry) as UserSocialLink[];

        recentData[i].data.socialLinks = uniq(userSocialLinks.map(link => cleanLink(link.outboundUrl)));
    }

    recentData = recentData.filter(item => item.data.socialLinks && item.data.socialLinks.length > 0);

    const evaluatorVariables = await getEvaluatorVariables(context);
    const configuredLinks = evaluatorVariables["sociallinks:badlinks"] as string[] | undefined ?? [];

    const socialLinksCounts: Record<string, SocialLinksEntry> = {};
    for (const item of recentData) {
        if (!item.data.socialLinks) {
            continue;
        }

        for (const link of item.data.socialLinks) {
            const existingEntry = socialLinksCounts[link];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (existingEntry) {
                socialLinksCounts[link] = {
                    hits: existingEntry.hits + 1,
                    coveredByEvaluator: existingEntry.coveredByEvaluator,
                    firstSeen: item.data.reportedAt ? min([existingEntry.firstSeen, new Date(item.data.reportedAt)]) ?? existingEntry.firstSeen : existingEntry.firstSeen,
                    lastSeen: item.data.reportedAt ? max([existingEntry.lastSeen, new Date(item.data.reportedAt)]) ?? existingEntry.lastSeen : existingEntry.lastSeen,
                    usernames: [...existingEntry.usernames, item.username],
                };
            } else {
                socialLinksCounts[link] = {
                    hits: 1,
                    coveredByEvaluator: configuredLinks.some(configuredLink => link.startsWith(configuredLink)),
                    firstSeen: item.data.reportedAt ? new Date(item.data.reportedAt) : undefined,
                    lastSeen: item.data.reportedAt ? new Date(item.data.reportedAt) : undefined,
                    usernames: [item.username],
                };
            }
        }
    }

    const bareDomainRegex = /^https:\/\/\w+\.\w+\\?$/;

    const records = Object.entries(socialLinksCounts)
        .map(([link, value]) => ({ link, value }))
        .filter(item => item.value.hits > 1 && !bareDomainRegex.test(item.link))
        .sort((a, b) => a.link > b.link ? 1 : -1)
        .sort((a, b) => b.value.hits - a.value.hits);

    const wikiContent: json2md.DataObject[] = [
        { p: "This page lists social links seen on more than one user, where it has been seen on a newly banned user in the last four weeks" },
        { p: "Note: OnlyFans links have been cleaned to remove share codes and trial invites." },
    ];

    if (records.length === 0) {
        wikiContent.push({ p: "No social links found more than once with a hit in the last four weeks." });
    } else {
        const coveredByEvaluatorRows: string[][] = [];
        const notCoveredByEvaluatorRows: string[][] = [];

        const headers = ["Link", "Hit count", "First Seen", "Last Seen", "Example Users"];

        for (const record of records) {
            const recordRow = [
                record.link,
                record.value.hits.toLocaleString(),
                record.value.firstSeen ? format(record.value.firstSeen, "MMM dd") : "",
                record.value.lastSeen ? format(record.value.lastSeen, "MMM dd") : "",
                uniq(record.value.usernames).map(username => `/u/${username}`).slice(-5).join(", "),
            ];

            if (record.value.coveredByEvaluator) {
                coveredByEvaluatorRows.push(recordRow);
            } else {
                notCoveredByEvaluatorRows.push(recordRow);
            }
        }

        wikiContent.push({ h2: "Links not covered by Evaluator configuration" });
        if (notCoveredByEvaluatorRows.length > 0) {
            wikiContent.push({ table: { headers, rows: notCoveredByEvaluatorRows } });
        } else {
            wikiContent.push({ p: "None! Well done!" });
        }

        wikiContent.push({ h2: "Links covered by Evaluator configuration" });
        if (coveredByEvaluatorRows.length > 0) {
            wikiContent.push({ table: { headers, rows: coveredByEvaluatorRows } });
        } else {
            wikiContent.push({ p: "None!" });
        }
    }

    if (configuredLinks.length > 0) {
        const bullets: string[] = [];
        for (const link of configuredLinks) {
            if (!records.some(record => record.link.startsWith(link))) {
                bullets.push(link);
            }
        }

        if (bullets.length > 0) {
            wikiContent.push({ hr: {} });
            wikiContent.push({ p: "The following links are in the Evaluator Configuration but have not been seen in the last four weeks:" });
            wikiContent.push({ ul: bullets });
        }
    }

    const wikiPageName = "statistics/social-links";

    await context.reddit.updateWikiPage({
        subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        page: wikiPageName,
        content: json2md(wikiContent),
    });
}
