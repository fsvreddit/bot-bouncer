import { JobContext, JSONObject, JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { getUserExtended } from "../extendedDevvit.js";
import { addDays } from "date-fns";
import { compact, uniq } from "lodash";
import { SequenceMatcher } from "./difflib.js";
import { getSubstitutedText } from "./substitutions.js";
import pluralize from "pluralize";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { evaluateUserAccount } from "../handleControlSubAccountEvaluation.js";
import { addExternalSubmissionsToQueue, ExternalSubmission } from "../externalSubmissions.js";

interface UserBioText {
    username: string;
    bioText: string;
}

async function getBioTextForUser (username: string, context: TriggerContext): Promise<UserBioText | undefined> {
    const cacheKey = `biotext~${username}`;
    const cachedBioText = await context.redis.get(cacheKey);
    if (cachedBioText) {
        if (cachedBioText === "undefined") {
            return;
        }

        return { username, bioText: cachedBioText };
    }

    const user = await getUserExtended(username, context);
    if (!user?.userDescription) {
        await context.redis.set(cacheKey, "undefined", { expiration: addDays(new Date(), 7) });
        return;
    }

    await context.redis.set(cacheKey, user.userDescription, { expiration: addDays(new Date(), 1) });
    return { username, bioText: user.userDescription };
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

    return uniq(posts.map(post => post.authorName));
}

async function getDistinctUsersFromSubreddits (subredditNames: string[], context: TriggerContext): Promise<string[]> {
    const userSets = await Promise.all(subredditNames.map(subredditName => getDistinctUsersFromSubreddit(subredditName, context)));
    return uniq(userSets.flat());
}

async function getEvaluatorVariables (context: TriggerContext): Promise<Record<string, JSONValue>> {
    const wikiPage = await context.reddit.getWikiPage("BotBouncer", "evaluatorvariables");
    return JSON.parse(wikiPage.content) as Record<string, JSONObject>;
}

function bioTextAlreadyBanned (bioText: string, variables: Record<string, JSONValue>): boolean {
    const regexes = variables["biotext:bantext"] as string[] | undefined ?? [];
    return regexes.some(regex => new RegExp(regex).test(bioText));
}

interface Match {
    user1: string;
    text1: string;
    user2: string;
    text2: string;
    ratio: number;
}

export async function analyseBioText (_: unknown, context: JobContext) {
    const BIO_TEXT_STORAGE_KEY = "BioTextSimilarity";

    const subreddits = [
        "WhatIsMyCQS",
    ];

    const users = await getDistinctUsersFromSubreddits(subreddits, context);

    let bioTextResults = compact(await Promise.all(users.map(username => getBioTextForUser(username, context))));
    const results: Record<string, UserBioText[]> = {};

    const evaluatorVariables = await getEvaluatorVariables(context);

    let bestMatch: Match | undefined = undefined;

    while (bioTextResults.length > 0) {
        const bioText = bioTextResults.shift();
        if (!bioText) {
            break;
        }

        if (bioTextAlreadyBanned(bioText.bioText, evaluatorVariables)) {
            continue;
        }

        const bioTextMatches = bioTextResults.map(otherBioText => ({ bioText: otherBioText, ratio: new SequenceMatcher(null, getSubstitutedText(bioText.bioText), getSubstitutedText(otherBioText.bioText)).ratio() }));
        const similarBioTexts = bioTextMatches.filter(match => match.ratio > 0.5).map(match => match.bioText);
        if (similarBioTexts.length === 0) {
            const [bestMatchInBatch] = bioTextMatches.sort((a, b) => b.ratio - a.ratio);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (bestMatchInBatch && (!bestMatch || bestMatchInBatch.ratio > bestMatch.ratio)) {
                bestMatch = { user1: bioText.username, text1: bioText.bioText, user2: bestMatchInBatch.bioText.username, text2: bestMatchInBatch.bioText.bioText, ratio: bestMatchInBatch.ratio };
            }
            continue;
        }

        // Remove similar bio texts from the working set.
        bioTextResults = bioTextResults.filter(originalBioText => !similarBioTexts.includes(originalBioText));

        // Add the original bio text to the results.
        results[bioText.bioText] = [bioText, ...similarBioTexts];
    }

    let output: string;
    const addableUsers: string[] = [];

    if (Object.keys(results).length === 0) {
        console.log("No similar bio text patterns found.");
        output = "No similar enough bio text patterns found on this run.\n\n";
    } else {
        let index = 1;
        output = "Here are some similar bio text patterns not already covered by the Bio Text evaluator and seen on swept subreddits recently:\n\n";
        // output += "To add all of these users to /r/BotBouncer with an initial status of pending, please reply with the command `!addall`, or to add with an initial status of banned, use `!addall banned`. Consider adjusting the list of regexes to capture these users\n\n";
        for (const similarTexts of Object.values(results)) {
            output += `**Pattern ${index++}**\n\n`;
            output += "| Username | Status | Evaluators | Bio Text |\n";
            output += "| -------- | ------ | ---------- | -------- |\n";
            for (const bioTextEntry of similarTexts) {
                const currentStatus = await getUserStatus(bioTextEntry.username, context);
                let evaluators = "";
                if (!currentStatus) {
                    const evaluatorsMatched = await evaluateUserAccount(bioTextEntry.username, context, false);
                    evaluators = evaluatorsMatched.map(evaluator => evaluator.botName).join(", ");
                }
                output += `| /u/${bioTextEntry.username} | ${currentStatus?.userStatus ?? ""} | ${evaluators} | ${bioTextEntry.bioText} |\n`;
                if (!currentStatus && evaluators === "") {
                    addableUsers.push(bioTextEntry.username);
                }
            }
            output += "\n";
        }

        output += "---\n\n";
        output += `Subreddits currently being swept for bio text: /r/${subreddits.join(", /r/")}\n\n`;

        await context.redis.zAdd(BIO_TEXT_STORAGE_KEY, ...Object.values(results).flat().map(item => ({ member: item.bioText, score: new Date().getTime() })));
    }

    const conversationId = await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Similar Bio Text Patterns spotted in swept subreddits",
        bodyMarkdown: output,
    });

    const bioTextUserKey = `biotextusers~${conversationId}`;
    if (addableUsers.length > 0) {
        await context.redis.set(bioTextUserKey, JSON.stringify(addableUsers), { expiration: addDays(new Date(), 7) });
    }
}

export async function addAllUsersFromModmail (conversationId: string, initialStatus: UserStatus, context: TriggerContext) {
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

    const accountsToSubmit: ExternalSubmission[] = usersToAdd.map(username => ({
        username,
        initialStatus,
        reportContext: "User with similar bio text to other users",
    }));

    await addExternalSubmissionsToQueue(accountsToSubmit, context);

    await context.reddit.modMail.reply({
        conversationId,
        body: `Added ${usersToAdd.length} ${pluralize("user", usersToAdd.length)} to the list with status ${initialStatus}.`,
        isInternal: true,
    });

    await context.redis.del(bioTextUserKey);
}
