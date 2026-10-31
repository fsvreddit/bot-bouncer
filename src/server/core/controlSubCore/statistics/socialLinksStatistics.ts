import { context, reddit, redis, UserSocialLink } from "@devvit/web/server";
import { format, subMonths } from "date-fns";
import { domainFromUrl, SOCIAL_LINKS_STORE, UserDetails } from "../..";
import { StatsUserEntry, userIsBanned } from "./statsHelpers";
import { getEvaluatorVariable, getRedisSubstitionValue, setRedisSubstititionValue } from "../../userEvaluation";
import json2md from "json2md";
import { chunk, max, min, uniq } from "lodash-es";

export function cleanLink (input: string): string {
    if (!input.includes("onlyfans.com") && !input.includes("fansly.com") && !input.includes("fans.ly") && !input.includes("snapchat.com") && !input.includes("fanvue.com")) {
        return input;
    }

    let newString = input;
    if (newString.startsWith("https://www.")) {
        newString = newString.replace("https://www.", "https://");
    }

    if (newString.startsWith("https://onlyfans.com/action/trial")) {
        return newString;
    }

    const linkRegex = /^(https:\/\/(?:onlyfans\.com|fansly\.com|fans\.ly)\/[\w\d.-]+\/)(?:[ct]\d+|trial)/;
    const matches = linkRegex.exec(newString);
    if (matches?.[1]) {
        newString = matches[1];
    }

    const snapchatRegex = /^(https:\/\/(?:www\.)?snapchat\.com\/add\/[\w\d._-]+)(?:\?share.*)?/;
    const snapchatMatches = snapchatRegex.exec(newString);
    if (snapchatMatches?.[1]) {
        newString = snapchatMatches[1];
    }

    if (!newString.endsWith("/")) {
        newString += "/";
    }

    const fanvueRegex1 = /^(https:\/\/www.fanvue.com\/[\w.-]+\/).+/;
    const fanvueMatches = fanvueRegex1.exec(input);
    if (fanvueMatches?.[1]) {
        newString = fanvueMatches[1];
    }

    const fanvueRegex2 = /^(https:\/\/www.fanvue.com\/[\w.-]+)\?.+/;
    const fanvueMatches2 = fanvueRegex2.exec(input);
    if (fanvueMatches2?.[1]) {
        newString = fanvueMatches2[1];
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

export async function updateSocialLinksStatistics (allEntries: StatsUserEntry[]) {
    const recentDataInit = allEntries
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        .map(item => ({ username: item.username, data: item.data as UserDetailsWithSocialLink }))
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subMonths(new Date(), 3))
        .filter(item => userIsBanned(item.data));

    const recentData: typeof recentDataInit = [];

    const chunks = chunk(recentDataInit, 5000);
    for (const chunk of chunks) {
        const socialLinks = await redis.hMGet(SOCIAL_LINKS_STORE, chunk.map(item => item.username));
        for (let i = 0; i < chunk.length; i++) {
            const socialLinksEntry = socialLinks[i];
            if (socialLinksEntry) {
                const socialLinksData = JSON.parse(socialLinksEntry) as UserSocialLink[];
                if (socialLinksData.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    chunk[i]!.data.socialLinks = uniq(socialLinksData.map(link => cleanLink(link.outboundUrl)));
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    recentData.push(chunk[i]!);
                }
            }
        }
    }

    const configuredLinks = await getEvaluatorVariable<string[]>("sociallinks:badlinks") ?? [];
    const ignoredLinks = await getEvaluatorVariable<string[]>("sociallinks:ignored") ?? [];

    const socialLinksCounts = new Map<string, SocialLinksEntry>();
    const domainCounts = new Map<string, number>();

    for (const item of recentData) {
        if (!item.data.socialLinks) {
            continue;
        }

        for (const link of item.data.socialLinks) {
            if (ignoredLinks.some(ignoredLink => new RegExp(ignoredLink).test(link))) {
                continue;
            }

            const domain = domainFromUrl(link);
            if (domain) {
                domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
            }

            const existingEntry = socialLinksCounts.get(link);
            if (existingEntry) {
                socialLinksCounts.set(link, {
                    hits: existingEntry.hits + 1,
                    coveredByEvaluator: existingEntry.coveredByEvaluator,
                    firstSeen: item.data.reportedAt ? min([existingEntry.firstSeen, new Date(item.data.reportedAt)]) ?? existingEntry.firstSeen : existingEntry.firstSeen,
                    lastSeen: item.data.reportedAt ? max([existingEntry.lastSeen, new Date(item.data.reportedAt)]) ?? existingEntry.lastSeen : existingEntry.lastSeen,
                    usernames: [...existingEntry.usernames, item.username],
                });
            } else {
                socialLinksCounts.set(link, {
                    hits: 1,
                    coveredByEvaluator: configuredLinks.some(configuredLink => link.startsWith(configuredLink)),
                    firstSeen: item.data.reportedAt ? new Date(item.data.reportedAt) : undefined,
                    lastSeen: item.data.reportedAt ? new Date(item.data.reportedAt) : undefined,
                    usernames: [item.username],
                });
            }
        }
    }

    const bareDomainRegex = /^https?:\/\/\w+\.\w+\\?$/;

    const records = Array.from(socialLinksCounts.entries())
        .map(([link, value]) => ({ link, value }))
        .filter(item => item.value.hits > 2 && !bareDomainRegex.test(item.link))
        .sort((a, b) => a.link > b.link ? 1 : -1)
        .sort((a, b) => b.value.hits - a.value.hits);

    const wikiContent: json2md.DataObject[] = [
        { p: "This page lists social links seen on more than two users, where it has been seen on a newly banned user in the last three months" },
        { p: "Note: OnlyFans links have been cleaned to remove share codes and trial invites." },
    ];

    if (records.length === 0) {
        wikiContent.push({ p: "No social links found more than twice with a hit in the last three months." });
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
            wikiContent.push({ p: "No action is needed on these. They will be automatically added to the config within an hour." });
            wikiContent.push({ table: { headers, rows: notCoveredByEvaluatorRows } });
        } else {
            wikiContent.push({ p: "None!" });
        }

        wikiContent.push({ h2: "Links covered by Evaluator configuration" });
        if (coveredByEvaluatorRows.length > 0) {
            wikiContent.push({ table: { headers, rows: coveredByEvaluatorRows } });
        } else {
            wikiContent.push({ p: "None!" });
        }
    }

    if (domainCounts.size > 0) {
        wikiContent.push({ hr: {} });
        wikiContent.push({ p: "Domain counts for social links seen on users with any status:" });
        const domainHeaders = ["Domain", "Count"];
        const domainRows = Array.from(domainCounts.entries()).map(([domain, count]) => [domain, count.toLocaleString()]);
        wikiContent.push({ table: { headers: domainHeaders, rows: domainRows } });
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

    await reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: wikiPageName,
        content: json2md(wikiContent),
    });

    const domainOnlyUrlRegex = /^https?:\/\/[^/]+\/?$/;
    const newSubstitionValue = records.map(record => record.link).filter(link => !domainOnlyUrlRegex.test(link));
    const existingSubstitionValue = new Set(await getRedisSubstitionValue<string[]>("sociallinks") ?? []);

    if (newSubstitionValue.length === existingSubstitionValue.size && newSubstitionValue.every(value => existingSubstitionValue.has(value))) {
        return;
    }

    await setRedisSubstititionValue("sociallinks", newSubstitionValue);
    console.log(`Updated social links substitution value with ${newSubstitionValue.length} entries`);
}
