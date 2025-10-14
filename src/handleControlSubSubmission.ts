import { TriggerContext, User } from "@devvit/public-api";
import { PostCreate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUsernameFromUrl, getUserOrUndefined, isModerator } from "./utility.js";
import { getUserStatus, touchUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { subMonths } from "date-fns";
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

    if (event.author.name === context.appName) {
        if (event.post.spam) {
            await context.reddit.approve(event.post.id);
        }
        return;
    }

    const submissionResponse: json2md.DataObject[] = [];

    const username = getUsernameFromUrl(event.post.url);

    if (!username) {
        if (await isModerator(event.author.name, context)) {
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
        const userContent = await context.reddit.getCommentsAndPostsByUser({
            username: user.username,
            limit: 100,
            sort: "new",
        }).all();

        if (userContent.filter(item => item.createdAt > subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3)).length === 0) {
            submissionResponse.push({ p: `${username} has no recent content on their history, so may be retired. Submissions can only be made for active users.` });
        }
    }

    if (user && submissionResponse.length === 0) {
        const currentStatus = await getUserStatus(user.username, context);
        if (currentStatus) {
            const post = await context.reddit.getPostById(currentStatus.trackingPostId);
            submissionResponse.push({ p: `${username} is already tracked by Bot Bouncer with a current status of ${currentStatus.userStatus}, you can see the submission [here](${post.permalink}).` });

            if (currentStatus.userStatus === UserStatus.Organic) {
                submissionResponse.push({ p: `If you have information about how this user is a bot that we may have missed, please [modmail us](https://www.reddit.com/message/compose?to=/r/BotBouncer&subject=More%20information%20about%20/u/${user.username}) with the details, so that we can review again.` });
            } else if (currentStatus.userStatus !== UserStatus.Pending) {
                await touchUserStatus(user.username, currentStatus, context);
            }
        } else {
            const newStatus = await userIsTrustedSubmitter(event.author.name, context) ? UserStatus.Banned : UserStatus.Pending;

            const newDetails: UserDetails = {
                userStatus: newStatus,
                lastUpdate: new Date().getTime(),
                submitter: event.author.name,
                operator: context.appName,
                trackingPostId: "",
            };

            const submission: AsyncSubmission = {
                user: await getUserExtendedFromUser(user, context),
                details: newDetails,
                callback: {
                    postId: event.post.id,
                    comment: json2md([
                        { p: "Hi, thanks for your submission." },
                        { p: `The post tracking ${user.username} can be found [here]({{permalink}}).` },
                        { p: `Your post has been removed, and can be deleted. Consider reporting the account for Spam->Bots, as this may result in the account being suspended or shadowbanned.` },
                    ]),
                },
                immediate: true,
            };

            const result = await queuePostCreation(submission, context);

            switch (result) {
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
                    console.error(`Failed to queue post creation for ${username} via post by ${event.author.name}. Reason: ${result}`);
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
