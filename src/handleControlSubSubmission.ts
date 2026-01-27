import { TriggerContext, User } from "@devvit/public-api";
import { PostCreate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUsernameFromUrl, getUserOrUndefined, isModeratorWithCache } from "./utility.js";
import { getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { addHours, subMonths } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import { AsyncSubmission, PostCreationQueueResult, queuePostCreation } from "./postCreation.js";
import { getUserExtendedFromUser } from "./extendedDevvit.js";
import json2md from "json2md";
import { userIsTrustedSubmitter } from "./trustedSubmitterHelpers.js";

export async function handleControlSubPostCreate (event: PostCreate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.post || !event.author) {
        return;
    }

    if (event.author.name === context.appSlug) {
        if (event.post.spam) {
            await context.reddit.approve(event.post.id);
        }
        return;
    }

    const postHandledKey = `controlSubPostHandled:${event.post.id}`;
    if (await context.redis.exists(postHandledKey)) {
        // Duplicate event
        return;
    }

    await context.redis.set(postHandledKey, "", { expiration: addHours(new Date(), 1) });

    const submissionResponse: json2md.DataObject[] = [];

    const username = getUsernameFromUrl(event.post.url);

    if (!username) {
        if (await isModeratorWithCache(event.author.name, context)) {
            // Allow mods to make meta submissions
            return;
        }

        submissionResponse.push({ p: "Only links to user accounts are permitted here." });
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.reporterBlacklist.includes(event.author.name) && submissionResponse.length === 0) {
        submissionResponse.push({ p: `You are not currently permitted to submit bots to r/${CONTROL_SUBREDDIT}. Please [message the mods](https://www.reddit.com/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you believe this is a mistake` });
    }

    const submitterStatus = await getUserStatus(event.author.name, context);
    if (submitterStatus?.userStatus === UserStatus.Banned && submissionResponse.length === 0) {
        submissionResponse.push({ p: `You are currently listed as a bot on r/${CONTROL_SUBREDDIT}, so we cannot accept submissions from you. Please [message the mods](https://www.reddit.com/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you believe this is a mistake` });
    }

    let user: User | undefined;
    if (username) {
        user = await getUserOrUndefined(username, context, true);
    }

    if (!user && submissionResponse.length === 0) {
        submissionResponse.push({ p: `${username} appears to be deleted, suspended or shadowbanned already, so no post will be created for it.` });
    }

    if (user?.username === event.author.name && submissionResponse.length === 0) {
        submissionResponse.push({ p: "You cannot make a submission for yourself." });
    }

    if (user) {
        try {
            const userContent = await context.reddit.getCommentsAndPostsByUser({
                username: user.username,
                limit: 100,
                sort: "new",
            }).all();

            if (userContent.filter(item => item.createdAt > subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3)).length === 0) {
                submissionResponse.push({ p: `${username} has no recent content on their history, so may be retired. Submissions can only be made for active users.` });
            }
        } catch (error) {
            console.error(`Error retrieving content for user ${username}:`, error);
        }
    }

    if (user && submissionResponse.length === 0) {
        const currentStatus = await getUserStatus(user.username, context);
        if (currentStatus) {
            const post = await context.reddit.getPostById(currentStatus.trackingPostId);
            submissionResponse.push({ p: `${username} is already tracked by Bot Bouncer with a current status of ${currentStatus.userStatus}, you can see the submission [here](${post.permalink}).` });

            if (currentStatus.userStatus === UserStatus.Organic) {
                submissionResponse.push({ p: `If you have information about how this user is a bot that we may have missed, please [modmail us](https://www.reddit.com/message/compose?to=/r/BotBouncer&subject=More%20information%20about%20/u/${user.username}) with the details, so that we can review again.` });
            }
        } else {
            const newStatus = await userIsTrustedSubmitter(event.author.name, context) ? UserStatus.Banned : UserStatus.Pending;

            const newDetails: UserDetails = {
                userStatus: newStatus,
                lastUpdate: new Date().getTime(),
                submitter: event.author.name,
                operator: context.appSlug,
                trackingPostId: "",
            };

            let submissionResult: PostCreationQueueResult;

            let contextComment: string | undefined;
            if (event.post.selftext && event.post.selftext.trim().length > 0) {
                const body: json2md.DataObject[] = [
                    { p: "The submitter added the following context for this submission:" },
                    { blockquote: event.post.selftext.trim() },
                ];

                body.push({ p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` });
                contextComment = json2md(body);
            }

            try {
                const submission: AsyncSubmission = {
                    user: await getUserExtendedFromUser(user, context),
                    details: newDetails,
                    commentToAdd: contextComment,
                    removeComment: contextComment !== undefined ? true : undefined,
                    callback: {
                        postId: event.post.id,
                        comment: json2md([
                            { p: "Hi, thanks for your submission." },
                            { p: `The post tracking ${user.username} can be found [here]({{permalink}}).` },
                            { p: `Your post has been removed, and can be deleted. Consider reporting the account for Spam->Bots, as this may result in the account being suspended or shadowbanned.` },
                        ]),
                    },
                    immediate: true,
                    evaluatorsChecked: false,
                };

                submissionResult = await queuePostCreation(submission, context);
            } catch {
                submissionResult = PostCreationQueueResult.Error;
            }

            switch (submissionResult) {
                case PostCreationQueueResult.Queued:
                    console.log(`Queued post creation for ${username} via post by ${event.author.name}`);
                    break;
                case PostCreationQueueResult.AlreadyInDatabase:
                    console.log(`Post creation for ${username} via post by ${event.author.name} is already in the database.`);
                    submissionResponse.push({ p: "This user is already in our database." });
                    break;
                case PostCreationQueueResult.AlreadyInQueue:
                    console.log(`Failed to queue post creation for ${username} via post by ${event.author.name} as it is already in the queue`);
                    submissionResponse.push({ p: "This user is already in the queue to be processed having been submitted by someone else, a tracking post will appear shortly." });
                    break;
                case PostCreationQueueResult.Error:
                    console.error(`Failed to queue post creation for ${username} via post by ${event.author.name}. Reason: ${submissionResult}`);
                    submissionResponse.push({ p: "An error occurred while processing your submission, please try again later." });
                    break;
            }
        }
    }

    if (submissionResponse.length > 0) {
        submissionResponse.unshift({ p: "Hi, thanks for your submission." });
        submissionResponse.push({ p: `Your post has been removed, and can be deleted.` });
        const newComment = await context.reddit.submitComment({
            id: event.post.id,
            text: json2md(submissionResponse),
        });
        await newComment.distinguish(true);
    }

    await context.reddit.remove(event.post.id, false);
}
