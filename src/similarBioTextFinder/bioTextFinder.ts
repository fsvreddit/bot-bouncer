import { JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { getUserExtended } from "@fsvreddit/fsv-devvit-helpers";
import { addDays, addHours } from "date-fns";
import _ from "lodash";
import { SequenceMatcher } from "./difflib.js";
import { getSubstitutedText } from "./substitutions.js";
import pluralize from "pluralize";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { evaluateUserAccount } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { AsyncSubmission, PostCreationQueueResult, queuePostCreation } from "../postCreation.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";

export const BIO_TEXT_STATS_SWEEP_CLUSTER_KEY = "BioTextStatsSweepClusters";

interface UserBioText {
    username: string;
    bioText: string;
    sourceSubreddits: string[];
}

interface UserBioTextForComparison extends UserBioText {
    coveredByBioTextEvaluator: boolean;
    substitutedBioText: string;
}

export interface BioTextSweepClusterMember {
    username: string;
    bioText: string;
    sourceSubreddits: string[];
    coveredByBioTextEvaluator: boolean;
}

export interface BioTextSweepCluster {
    representativeBioText: string;
    users: string[];
    sourceSubreddits: string[];
    lastSeen: number;
    coveredUsers: string[];
    uncoveredUsers: string[];
    entries: BioTextSweepClusterMember[];
    matchType: "exact" | "normalized" | "similar";
    highestSimilarity: number;
    lowestSimilarity: number;
}

export interface BioTextSweepStatsPayload {
    generatedAt: number;
    subreddits: string[];
    clusters: BioTextSweepCluster[];
}

interface UserSweepEntry {
    username: string;
    sourceSubreddits: string[];
}

interface Match {
    user1: string;
    text1: string;
    user2: string;
    text2: string;
    ratio: number;
}

interface BioTextMatch {
    user1: string;
    user2: string;
    ratio: number;
}

class UnionFind {
    private readonly parents: Record<string, string>;

    public constructor (items: string[]) {
        this.parents = _.fromPairs(items.map(item => [item, item]));
    }

    public find (item: string): string {
        const parent = this.parents[item] ?? item;
        this.parents[item] = parent;
        if (parent === item) {
            return item;
        }

        const root = this.find(parent);
        this.parents[item] = root;
        return root;
    }

    public union (item1: string, item2: string) {
        const root1 = this.find(item1);
        const root2 = this.find(item2);
        if (root1 !== root2) {
            this.parents[root2] = root1;
        }
    }
}

async function getBioTextForUser (user: UserSweepEntry, context: TriggerContext): Promise<UserBioText | undefined> {
    const cacheKey = `biotext~${user.username}`;
    const cachedBioText = await context.redis.get(cacheKey);
    if (cachedBioText) {
        if (cachedBioText === "undefined") {
            return;
        }

        return { username: user.username, bioText: cachedBioText, sourceSubreddits: user.sourceSubreddits };
    }

    const redditUser = await getUserExtended(user.username, context);
    if (!redditUser?.userDescription) {
        await context.redis.set(cacheKey, "undefined", { expiration: addDays(new Date(), 7) });
        return;
    }

    await context.redis.set(cacheKey, redditUser.userDescription, { expiration: addDays(new Date(), 1) });
    return { username: user.username, bioText: redditUser.userDescription, sourceSubreddits: user.sourceSubreddits };
}

async function getDistinctUsersFromSubreddit (subredditName: string, context: TriggerContext): Promise<string[]> {
    let posts: Post[];
    try {
        posts = await context.reddit.getNewPosts({
            subredditName,
            limit: 100,
        }).all();
    } catch (error) {
        console.error(`Error fetching posts from subreddit ${subredditName}:`, error);
        return [];
    }

    return _.uniq(posts
        .map(post => post.authorName)
        .filter((username): username is string => Boolean(username) && username !== "[deleted]"));
}

async function getDistinctUsersFromSubreddits (subredditNames: string[], context: TriggerContext): Promise<UserSweepEntry[]> {
    const entriesByUsername: Record<string, UserSweepEntry> = {};

    const userSets = await Promise.all(subredditNames.map(async subredditName => ({
        subredditName,
        users: await getDistinctUsersFromSubreddit(subredditName, context),
    })));

    for (const userSet of userSets) {
        for (const username of userSet.users) {
            const existingEntry = entriesByUsername[username];
            if (existingEntry) {
                existingEntry.sourceSubreddits = _.uniq([...existingEntry.sourceSubreddits, userSet.subredditName]);
            } else {
                entriesByUsername[username] = {
                    username,
                    sourceSubreddits: [userSet.subredditName],
                };
            }
        }
    }

    return Object.values(entriesByUsername);
}

function bioTextAlreadyBanned (bioText: string, variables: Record<string, JSONValue>): boolean {
    const regexes = variables["biotext:bantext"] as string[] | undefined ?? [];
    return regexes.some(regex => new RegExp(regex).test(bioText));
}

function shouldCompareBioTexts (bioText1: UserBioTextForComparison, bioText2: UserBioTextForComparison): boolean {
    if (bioText1.substitutedBioText === bioText2.substitutedBioText) {
        return true;
    }

    const shorterLength = Math.min(bioText1.substitutedBioText.length, bioText2.substitutedBioText.length);
    const longerLength = Math.max(bioText1.substitutedBioText.length, bioText2.substitutedBioText.length);

    if (shorterLength < 16) {
        return false;
    }

    return shorterLength / longerLength >= 0.55;
}

function getMatchType (cluster: UserBioTextForComparison[]): BioTextSweepCluster["matchType"] {
    if (_.uniq(cluster.map(item => item.bioText)).length === 1) {
        return "exact";
    }

    if (_.uniq(cluster.map(item => item.substitutedBioText)).length === 1) {
        return "normalized";
    }

    return "similar";
}

function getClusterRepresentative (cluster: UserBioTextForComparison[]): UserBioTextForComparison {
    const representative = cluster.find(item => !item.coveredByBioTextEvaluator) ?? cluster[0];
    if (!representative) {
        throw new Error("Cannot get representative bio text from empty cluster");
    }
    return representative;
}

function buildBioTextClusters (bioTextResults: UserBioText[], evaluatorVariables: Record<string, JSONValue>, minimumClusterSize: number): { clusters: BioTextSweepCluster[]; bestMatch?: Match } {
    const comparisonEntries = bioTextResults.map(item => ({
        ...item,
        coveredByBioTextEvaluator: bioTextAlreadyBanned(item.bioText, evaluatorVariables),
        substitutedBioText: getSubstitutedText(item.bioText),
    }));

    const unionFind = new UnionFind(comparisonEntries.map(item => item.username));
    const matches: BioTextMatch[] = [];
    let bestMatch: Match | undefined = undefined;

    for (let i = 0; i < comparisonEntries.length; i++) {
        const bioText = comparisonEntries[i];
        for (let j = i + 1; j < comparisonEntries.length; j++) {
            const otherBioText = comparisonEntries[j];
            if (!shouldCompareBioTexts(bioText, otherBioText)) {
                continue;
            }

            const ratio = bioText.substitutedBioText === otherBioText.substitutedBioText
                ? 1
                : new SequenceMatcher(null, bioText.substitutedBioText, otherBioText.substitutedBioText).ratio();

            if (!bestMatch || ratio > bestMatch.ratio) {
                bestMatch = { user1: bioText.username, text1: bioText.bioText, user2: otherBioText.username, text2: otherBioText.bioText, ratio };
            }

            if (ratio > 0.5) {
                matches.push({ user1: bioText.username, user2: otherBioText.username, ratio });
                unionFind.union(bioText.username, otherBioText.username);
            }
        }
    }

    const entriesByRoot: Record<string, UserBioTextForComparison[]> = {};
    for (const bioText of comparisonEntries) {
        const root = unionFind.find(bioText.username);
        entriesByRoot[root] ??= [];
        entriesByRoot[root].push(bioText);
    }

    const clusters: BioTextSweepCluster[] = [];
    const matchedRatiosByRoot: Record<string, number[]> = {};
    for (const match of matches) {
        const root = unionFind.find(match.user1);
        matchedRatiosByRoot[root] ??= [];
        matchedRatiosByRoot[root].push(match.ratio);
    }

    for (const [root, cluster] of Object.entries(entriesByRoot)) {
        if (cluster.length < minimumClusterSize) {
            continue;
        }

        const uncoveredUsers = cluster
            .filter(item => !item.coveredByBioTextEvaluator)
            .map(item => item.username);
        if (uncoveredUsers.length === 0) {
            continue;
        }

        const coveredUsers = cluster
            .filter(item => item.coveredByBioTextEvaluator)
            .map(item => item.username);
        const ratios = matchedRatiosByRoot[root] ?? [1];
        const representative = getClusterRepresentative(cluster);

        clusters.push({
            representativeBioText: representative.bioText,
            users: cluster.map(item => item.username),
            sourceSubreddits: _.uniq(cluster.flatMap(item => item.sourceSubreddits)).sort(),
            lastSeen: new Date().getTime(),
            coveredUsers,
            uncoveredUsers,
            entries: cluster.map(item => ({
                username: item.username,
                bioText: item.bioText,
                sourceSubreddits: item.sourceSubreddits,
                coveredByBioTextEvaluator: item.coveredByBioTextEvaluator,
            })),
            matchType: getMatchType(cluster),
            highestSimilarity: Math.max(...ratios),
            lowestSimilarity: Math.min(...ratios),
        });
    }

    clusters.sort((a, b) => b.uncoveredUsers.length - a.uncoveredUsers.length || b.users.length - a.users.length || b.highestSimilarity - a.highestSimilarity);

    return { clusters, bestMatch };
}

async function getBioTextClustersForSubreddits (subreddits: string[], evaluatorVariables: Record<string, JSONValue>, minimumClusterSize: number, context: TriggerContext): Promise<{ clusters: BioTextSweepCluster[]; bestMatch?: Match }> {
    if (subreddits.length === 0) {
        return { clusters: [] };
    }

    const users = await getDistinctUsersFromSubreddits(subreddits, context);
    const maxUsers = evaluatorVariables["biotext:sweepMaxUsers"] as number | undefined ?? 500;
    const usersToCheck = users.slice(0, maxUsers);

    const bioTextResults = _.compact(await Promise.all(usersToCheck.map(user => getBioTextForUser(user, context))));
    return buildBioTextClusters(bioTextResults, evaluatorVariables, minimumClusterSize);
}

async function updateStatsSweepClusters (evaluatorVariables: Record<string, JSONValue>, context: TriggerContext) {
    const subreddits = evaluatorVariables["biotext:statsSweepSubreddits"] as string[] | undefined ?? [];
    if (subreddits.length === 0) {
        await context.redis.del(BIO_TEXT_STATS_SWEEP_CLUSTER_KEY);
        return;
    }

    const { clusters } = await getBioTextClustersForSubreddits(subreddits, evaluatorVariables, 3, context);
    const payload: BioTextSweepStatsPayload = {
        generatedAt: new Date().getTime(),
        subreddits,
        clusters: clusters.slice(0, 25),
    };

    await context.redis.set(BIO_TEXT_STATS_SWEEP_CLUSTER_KEY, JSON.stringify(payload), { expiration: addDays(new Date(), 14) });
}

export async function analyseBioText (context: TriggerContext) {
    const recentlyRunKey = "BioTextAnalysisRecentlyRunValue";
    if (await context.redis.exists(recentlyRunKey)) {
        console.log("Bio text analysis recently run, skipping this execution.");
        return;
    }
    await context.redis.set(recentlyRunKey, "true", { expiration: addHours(new Date(), 12) });

    const BIO_TEXT_STORAGE_KEY = "BioTextSimilarity";
    const BIO_TEXT_MODMAIL_SENT = "BioTextModmailSent";

    const evaluatorVariables = await getEvaluatorVariables(context);
    const subreddits = evaluatorVariables["generic:cqsbiosweepsubs"] as string[] | undefined ?? [];

    await updateStatsSweepClusters(evaluatorVariables, context);

    if (subreddits.length === 0) {
        console.log("No CQS bio text sweep subreddits configured; statistics-only sweep complete.");
        return;
    }

    const { clusters, bestMatch } = await getBioTextClustersForSubreddits(subreddits, evaluatorVariables, 2, context);
    const output: json2md.DataObject[] = [];
    const addableUsers: string[] = [];

    if (clusters.length === 0) {
        const recentlySent = await context.redis.exists(BIO_TEXT_MODMAIL_SENT);
        if (recentlySent) {
            console.log("No similar bio text patterns found, and a modmail was sent recently.");
            return;
        }
        console.log("No similar bio text patterns found.");
        output.push({ p: "No similar enough bio text patterns found on this run." });
        if (bestMatch) {
            output.push({ p: `Closest pair on this run had similarity ${bestMatch.ratio.toFixed(2)}: /u/${bestMatch.user1} and /u/${bestMatch.user2}.` });
        }
    } else {
        const variables = await getEvaluatorVariables(context);
        let index = 1;

        output.push({ p: "Here are some similar bio text patterns with at least one entry not already covered by the Bio Text evaluator and seen on swept subreddits recently:" });

        for (const cluster of clusters) {
            output.push({ p: `**Pattern ${index++}**` });
            output.push({ p: `Match type: ${cluster.matchType}; similarity range: ${cluster.lowestSimilarity.toFixed(2)}-${cluster.highestSimilarity.toFixed(2)}; sources: /r/${cluster.sourceSubreddits.join(", /r/")}` });

            const rows: string[][] = [];
            for (const bioTextEntry of cluster.entries) {
                const currentStatus = await getUserStatus(bioTextEntry.username, context);
                const evaluatorsMatched = await evaluateUserAccount({
                    username: bioTextEntry.username,
                    variables,
                }, context);
                const evaluators = evaluatorsMatched.map(evaluator => evaluator.botName).join(", ");
                const coverage = bioTextEntry.coveredByBioTextEvaluator ? "Covered" : "Not covered";
                rows.push([`/u/${bioTextEntry.username}`, currentStatus?.userStatus ?? "", evaluators, coverage, bioTextEntry.bioText]);
                if (!bioTextEntry.coveredByBioTextEvaluator && !currentStatus && evaluators === "") {
                    addableUsers.push(bioTextEntry.username);
                }
            }

            output.push({ table: { headers: ["Username", "Status", "Evaluators", "Bio Text Evaluator", "Bio Text"], rows } });
        }

        output.push({ hr: {} });

        output.push({ p: `Subreddits currently being swept for bio text: /r/${subreddits.join(", /r/")}` });
        output.push({ p: `If you want to submit all users with similar bio text to Bot Bouncer, please reply to this modmail with \`!addall\` or \`!addall banned\`` });

        await context.redis.zAdd(BIO_TEXT_STORAGE_KEY, ...clusters.flatMap(cluster => cluster.entries.map(item => ({ member: item.bioText, score: new Date().getTime() }))));
    }

    const conversationId = await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Similar Bio Text Patterns spotted in swept subreddits",
        bodyMarkdown: json2md(output),
    });

    await context.redis.set(BIO_TEXT_MODMAIL_SENT, "true", { expiration: addDays(new Date(), 1) });

    const bioTextUserKey = `biotextusers~${conversationId}`;
    if (addableUsers.length > 0) {
        await context.redis.set(bioTextUserKey, JSON.stringify(_.uniq(addableUsers)), { expiration: addDays(new Date(), 7) });
    }
}

export async function addAllUsersFromModmail (conversationId: string, submitter: string | undefined, initialStatus: UserStatus, context: TriggerContext) {
    const bioTextUserKey = `biotextusers~${conversationId}`;
    const bioTextUsers = await context.redis.get(bioTextUserKey);
    const usersToAdd: string[] = [];

    let problem: string | undefined;
    if (!bioTextUsers) {
        problem = "Could not find any users to add.";
    } else {
        usersToAdd.push(...JSON.parse(bioTextUsers) as string[]);
        if (usersToAdd.length === 0) {
            problem = "Could not find any users to add.";
        }
    }

    if (problem) {
        await context.reddit.modMail.reply({
            conversationId,
            body: problem,
            isInternal: true,
        });
        return;
    };

    const submissions: AsyncSubmission[] = [];
    for (const username of usersToAdd) {
        const user = await getUserExtended(username, context);
        if (!user) {
            continue;
        }

        submissions.push({
            user,
            details: {
                userStatus: initialStatus,
                lastUpdate: new Date().getTime(),
                submitter: submitter ?? "unknown",
                operator: context.appSlug,
                trackingPostId: "",
                reportedAt: new Date().getTime(),
            },
            immediate: false,
            evaluatorsChecked: false,
        });
    }

    const results = await queuePostCreation(submissions, context);
    const queuedCount = results.filter(result => result === PostCreationQueueResult.Queued).length;

    console.log(`Added ${queuedCount} users to the queue following !addall command in modmail.`);
    if (results.some(result => result !== PostCreationQueueResult.Queued)) {
        console.error(`Some users were not added to the queue following !addall command in modmail. Reasons: ${_.uniq(results).join(", ")}`);
    }

    await context.reddit.modMail.reply({
        conversationId,
        body: `Added ${usersToAdd.length} ${pluralize("user", usersToAdd.length)} to the list with status ${initialStatus}.`,
        isInternal: true,
    });

    await context.redis.del(bioTextUserKey);
}
