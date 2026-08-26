import { Post, TriggerContext } from "@devvit/public-api";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserExtended } from "@fsvreddit/fsv-devvit-helpers";
import _ from "lodash";
import { getUserSocialLinks } from "devvit-helpers";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { evaluateUserAccount, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { normaliseHitReason } from "../utility.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";

interface PostInfo {
    title: string;
    createdAt: Date;
    url?: string;
}

export async function getUserInfoForOpenAI (username: string, context: TriggerContext) {
    try {
        const user = await getUserExtended(username, context);
        if (!user) {
            return;
        }

        const socialLinks = await getUserSocialLinks(username, context.metadata);

        const history = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
            sort: "new",
        }).all();

        const postInfoMap: Record<string, PostInfo> = {};
        const uniqueCommentPosts = _.uniq(history.filter(item => "postId" in item).map(comment => comment.postId));

        await Promise.all(uniqueCommentPosts.map(async (postId) => {
            let post: Post;
            try {
                post = await context.reddit.getPostById(postId);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`Failed to fetch post info for postId ${postId}:`, message);
                return;
            }

            postInfoMap[postId] = {
                title: post.title,
                createdAt: post.createdAt,
                url: post.url,
            };
        }));

        const modNotes = await context.reddit.getModNotes({
            user: username,
            subreddit: CONTROL_SUBREDDIT,
            filter: "NOTE",
        }).all().then(notes => notes.filter(note => note.userNote?.note && note.operator.name !== username && !note.userNote.note.startsWith("Status changed to")));

        const initialEvaluationResults = await getAccountInitialEvaluationResults(username, context);
        for (const evaluationResult of initialEvaluationResults) {
            if (evaluationResult.hitReason) {
                evaluationResult.hitReason = normaliseHitReason(evaluationResult.hitReason);
            }
        }

        const currentAccountEvaluationResults = await evaluateUserAccount({
            username,
            variables: await getEvaluatorVariables(context),
            history,
        }, context);

        for (const evaluationResult of currentAccountEvaluationResults) {
            if (evaluationResult.hitReason) {
                evaluationResult.hitReason = normaliseHitReason(evaluationResult.hitReason);
            }
        }

        return {
            userInfo: {
                ...user,
                socialLinks: socialLinks.map(link => ({ title: link.title, url: link.outboundUrl })),
            },
            modNotesAboutUser: modNotes.map(note => ({
                note: note.userNote?.note,
                createdAt: note.createdAt,
                operator: note.operator.name,
            })),
            initialReasonsForFlaggingAsBot: initialEvaluationResults,
            currentAccountEvaluationResults,
            history: history.map((item) => {
                if ("postId" in item) {
                    return {
                        type: "comment",
                        content: item.body,
                        karma: item.score,
                        subredditName: item.subredditName,
                        createdAt: item.createdAt,
                        isTopLevel: isLinkId(item.parentId),
                        edited: item.edited ? true : undefined,
                        parentPostInfo: postInfoMap[item.postId],
                    };
                } else {
                    return {
                        type: "post",
                        title: item.title,
                        content: item.body,
                        karma: item.score,
                        subredditName: item.subredditName,
                        createdAt: item.createdAt,
                        url: item.url,
                        isPinnedToProfile: item.stickied ? true : undefined,
                        edited: item.edited ? true : undefined,
                        nsfw: item.nsfw ? true : undefined,
                    };
                }
            }),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        console.error(`Error in getUserInfoForOpenAI for username ${username}:`, errorMessage);
    }
}
