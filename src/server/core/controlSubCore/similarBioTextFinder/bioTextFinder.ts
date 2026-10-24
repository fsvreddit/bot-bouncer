import { context, Post, reddit, redis } from "@devvit/web/server";
import { JsonValue } from "@devvit/web/shared";
import { getUserExtended } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addHours } from "date-fns";
import { getEvaluatorVariables } from "../../userEvaluation";
import { SequenceMatcher } from "./difflib";
import { getSubstitutedText } from "./substitutions";
import json2md from "json2md";
import { AsyncSubmission, evaluateUserAccount, getUserStatus, PostCreationQueueResult, queuePostCreation } from "../..";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import pluralize from "pluralize";
import { compact, uniq } from "lodash-es";

interface UserBioText {
    username: string;
    bioText: string;
}

async function getBioTextForUser (username: string): Promise<UserBioText | undefined> {
    const cacheKey = `biotext~${username}`;
    const cachedBioText = await redis.get(cacheKey);
    if (cachedBioText) {
        if (cachedBioText === "undefined") {
            return;
        }

        return { username, bioText: cachedBioText };
    }

    const user = await getUserExtended(username);
    if (!user?.userDescription) {
        await redis.set(cacheKey, "undefined", { expiration: addDays(new Date(), 7) });
        return;
    }

    await redis.set(cacheKey, user.userDescription, { expiration: addDays(new Date(), 1) });
    return { username, bioText: user.userDescription };
}

async function getDistinctUsersFromSubreddit (subredditName: string): Promise<string[]> {
    let posts: Post[];
    try {
        posts = await reddit.getNewPosts({
            subredditName,
            limit: 100,
        }).all();
    } catch (error) {
        console.error(`Error fetching posts from subreddit ${subredditName}:`, error);
        return [];
    }

    return uniq(posts.map(post => post.authorName));
}

async function getDistinctUsersFromSubreddits (subredditNames: string[]): Promise<string[]> {
    const userSets = await Promise.all(subredditNames.map(subredditName => getDistinctUsersFromSubreddit(subredditName)));
    return uniq(userSets.flat());
}

function bioTextAlreadyBanned (bioText: string, variables: Record<string, JsonValue>): boolean {
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

export async function analyseBioText () {
    const recentlyRunKey = "BioTextAnalysisRecentlyRunValue";
    if (await redis.exists(recentlyRunKey)) {
        console.log("Bio text analysis recently run, skipping this execution.");
        return;
    }
    await redis.set(recentlyRunKey, "true", { expiration: addHours(new Date(), 12) });

    const BIO_TEXT_STORAGE_KEY = "BioTextSimilarity";
    const BIO_TEXT_MODMAIL_SENT = "BioTextModmailSent";

    const evaluatorVariables = await getEvaluatorVariables();
    const subreddits = evaluatorVariables["generic:cqsbiosweepsubs"] as string[] | undefined ?? [];

    const users = await getDistinctUsersFromSubreddits(subreddits);

    let bioTextResults = compact(await Promise.all(users.map(username => getBioTextForUser(username))));
    const results: Record<string, UserBioText[]> = {};

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

    const output: json2md.DataObject[] = [];
    const addableUsers: string[] = [];

    if (Object.keys(results).length === 0) {
        return;
    } else {
        const variables = await getEvaluatorVariables();
        let index = 1;

        output.push({ p: "Here are some similar bio text patterns not already covered by the Bio Text evaluator and seen on swept subreddits recently:" });

        for (const similarTexts of Object.values(results)) {
            output.push({ p: `**Pattern ${index++}**` });

            const rows: string[][] = [];
            for (const bioTextEntry of similarTexts) {
                const currentStatus = await getUserStatus(bioTextEntry.username);
                const evaluatorsMatched = await evaluateUserAccount({
                    username: bioTextEntry.username,
                    variables,
                });
                const evaluators = evaluatorsMatched.map(evaluator => evaluator.botName).join(", ");
                rows.push([`/u/${bioTextEntry.username}`, currentStatus?.userStatus ?? "", evaluators, bioTextEntry.bioText]);
                if (!currentStatus && evaluators === "") {
                    addableUsers.push(bioTextEntry.username);
                }
            }

            output.push({ table: { headers: ["Username", "Status", "Evaluators", "Bio Text"], rows } });
        }

        output.push({ hr: {} });

        output.push({ p: `Subreddits currently being swept for bio text: /r/${subreddits.join(", /r/")}` });
        output.push({ p: `If you want to submit all users with similar bio text to Bot Bouncer, please reply to this modmail with \`!addall\` or \`!addall banned\`` });

        await redis.zAdd(BIO_TEXT_STORAGE_KEY, ...Object.values(results).flat().map(item => ({ member: item.bioText, score: new Date().getTime() })));
    }

    const conversationId = await reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: "Similar Bio Text Patterns spotted in swept subreddits",
        bodyMarkdown: json2md(output),
    });

    await redis.set(BIO_TEXT_MODMAIL_SENT, "true", { expiration: addDays(new Date(), 1) });

    const bioTextUserKey = `biotextusers~${conversationId}`;
    if (addableUsers.length > 0) {
        await redis.set(bioTextUserKey, JSON.stringify(addableUsers), { expiration: addDays(new Date(), 7) });
    }
}

export async function addAllUsersFromModmail (conversationId: string, submitter: string | undefined, initialStatus: UserStatus) {
    const bioTextUserKey = `biotextusers~${conversationId}`;
    const bioTextUsers = await redis.get(bioTextUserKey);
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
        await reddit.modMail.reply({
            conversationId,
            body: problem,
            isInternal: true,
        });
        return;
    };

    const submissions: AsyncSubmission[] = [];
    for (const username of usersToAdd) {
        const user = await getUserExtended(username);
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

    const results = await queuePostCreation(submissions);
    const queuedCount = results.filter(result => result === PostCreationQueueResult.Queued).length;

    console.log(`Added ${queuedCount} users to the queue following !addall command in modmail.`);
    if (results.some(result => result !== PostCreationQueueResult.Queued)) {
        console.error(`Some users were not added to the queue following !addall command in modmail. Reasons: ${uniq(results).join(", ")}`);
    }

    await reddit.modMail.reply({
        conversationId,
        body: `Added ${usersToAdd.length} ${pluralize("user", usersToAdd.length)} to the list with status ${initialStatus}.`,
        isInternal: true,
    });

    await redis.del(bioTextUserKey);
}
