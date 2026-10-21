import { context, reddit, User } from "@devvit/web/server";
import { OnPostCreateRequest, T3 } from "@devvit/web/shared";
import { fixPostTriggerEvent, getUserExtendedFromUser, getUserOrUndefined } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import json2md from "json2md";
import { AsyncSubmission, CONTROL_SUBREDDIT, getControlSubSettings, getUsernameFromUrl, getUserStatus, isModeratorWithCache, PostCreationQueueResult, queuePostCreation, UserDetails, userIsTrustedSubmitter } from "..";
import { subMonths } from "date-fns";
import markdownEscape from "markdown-escape";

async function postSubmissionResponse (opts: {
    submissionResponse: json2md.DataObject[];
    postId: T3;
}) {
    const { submissionResponse, postId } = opts;

    if (submissionResponse.length > 0) {
        submissionResponse.unshift({ p: "Hi, thanks for your submission." });
        submissionResponse.push({ p: `Your post has been removed, and can be deleted.` });
        const newComment = await reddit.submitComment({
            id: postId,
            text: json2md(submissionResponse),
        });
        await newComment.distinguish(true);
    }

    await reddit.remove(postId, false);
}

export async function handleControlSubPostCreate (event: OnPostCreateRequest) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Content Create: handleControlSubPostCreate should only be called for the control subreddit, check the subreddit name handling logic");
    }

    event = await fixPostTriggerEvent(event);

    if (!event.post || !event.author) {
        throw new Error("Content Create: handleControlSubPostCreate should not be called with missing post or author information");
    }

    if (event.author.name === context.appSlug) {
        if (event.post.spam) {
            await reddit.approve(event.post.id as T3);
        }
        return;
    }

    const username = getUsernameFromUrl(event.post.url);

    if (!username) {
        if (await isModeratorWithCache(event.author.name)) {
            // Allow mods to make meta submissions
            return;
        }

        await postSubmissionResponse({
            submissionResponse: [{ p: "Only links to user accounts are permitted here." }],
            postId: event.post.id as T3,
        });
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowNewSubmissions) {
        await postSubmissionResponse({
            submissionResponse: [{ p: "Bot Bouncer is not currently accepting new submissions." }],
            postId: event.post.id as T3,
        });
        console.log(`New Submissions: ${event.post.id} by ${event.author.name} was removed as new submissions are not currently allowed.`);
        return;
    }

    const reporterBlacklist = new Set(controlSubSettings.reporterBlacklist.map(entry => entry.toLowerCase()));
    if (reporterBlacklist.has(event.author.name.toLowerCase())) {
        await postSubmissionResponse({
            submissionResponse: [{ p: `You are not currently permitted to submit bots to r/${CONTROL_SUBREDDIT}. Please [message the mods](https://www.reddit.com/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you believe this is a mistake` }],
            postId: event.post.id as T3,
        });
        console.log(`New Submissions: ${event.post.id} by ${event.author.name} was removed as the user is blacklisted.`);
        return;
    }

    const submitterStatus = await getUserStatus(event.author.name);
    if (submitterStatus?.userStatus === UserStatus.Banned) {
        await postSubmissionResponse({
            submissionResponse: [{ p: `You are currently listed as a bot on r/${CONTROL_SUBREDDIT}, so we cannot accept submissions from you. Please [message the mods](https://www.reddit.com/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you believe this is a mistake` }],
            postId: event.post.id as T3,
        });
        console.log(`New Submissions: ${event.post.id} by ${event.author.name} was removed as the user is banned.`);
        return;
    }

    let user: User | undefined;
    if (username) {
        user = await getUserOrUndefined(username);
    }

    if (!user) {
        await postSubmissionResponse({
            submissionResponse: [{ p: `${username} appears to be deleted, suspended or shadowbanned already, so no post will be created for it.` }],
            postId: event.post.id as T3,
        });
        console.log(`New Submissions: ${event.post.id} by ${event.author.name} was removed as the user does not exist.`);
        return;
    }

    if (user.username === event.author.name) {
        await postSubmissionResponse({
            submissionResponse: [{ p: "You cannot make a submission for yourself." }],
            postId: event.post.id as T3,
        });
        console.log(`New Submissions: ${event.post.id} by ${event.author.name} was removed as the user attempted to submit themselves.`);
        return;
    }

    try {
        const userContent = await reddit.getCommentsAndPostsByUser({
            username: user.username,
            limit: 100,
            sort: "new",
        }).all();

        if (userContent.filter(item => item.createdAt > subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3)).length === 0) {
            await postSubmissionResponse({
                submissionResponse: [{ p: `${markdownEscape(user.username)} has no recent content on their history, so may be retired. Submissions can only be made for active users.` }],
                postId: event.post.id as T3,
            });
            console.log(`New Submissions: ${event.post.id} by ${event.author.name} was removed as ${user.username} has no recent content.`);
            return;
        }
    } catch (error) {
        console.error(`Error retrieving content for user ${event.author.name}:`, error);
    }

    const currentStatus = await getUserStatus(user.username);
    if (currentStatus) {
        const post = await reddit.getPostById(currentStatus.trackingPostId as T3);
        const submissionResponse: json2md.DataObject[] = [
            { p: `${markdownEscape(user.username)} is already tracked by Bot Bouncer with a current status of ${currentStatus.userStatus}, you can see the submission [here](${post.permalink}).` },
        ];

        if (currentStatus.userStatus === UserStatus.Organic) {
            submissionResponse.push({ p: `If you have information about how this user is a bot that we may have missed, please [message us](https://www.reddit.com/message/compose?to=/r/BotBouncer&subject=More%20information%20about%20/u/${user.username}) with the details, so that we can review again.` });
        }

        await postSubmissionResponse({
            submissionResponse,
            postId: event.post.id as T3,
        });
        return;
    }

    const submissionPost = await reddit.getPostById(event.post.id as T3);

    const newStatus = await userIsTrustedSubmitter(event.author.name) ? UserStatus.Banned : UserStatus.Pending;

    const newDetails: UserDetails = {
        userStatus: newStatus,
        lastUpdate: new Date().getTime(),
        submitter: event.author.name,
        operator: context.appSlug,
        trackingPostId: "",
    };

    let submissionResult: PostCreationQueueResult;

    let contextComment: string | undefined;
    if (submissionPost.body && submissionPost.body.trim().length > 0) {
        const body: json2md.DataObject[] = [
            { p: "The submitter added the following context for this submission:" },
            { blockquote: submissionPost.body.trim() },
        ];

        body.push({ p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` });
        contextComment = json2md(body);
    }

    let reportContext = submissionPost.body ? submissionPost.body.trim() : undefined;
    if (!reportContext && submissionPost.title.toLowerCase().startsWith("reason: ")) {
        reportContext = submissionPost.title.substring("Reason: ".length).trim();
    }

    try {
        const submission: AsyncSubmission = {
            user: await getUserExtendedFromUser(user),
            submitter: event.author.name,
            reportContext,
            details: newDetails,
            commentToAdd: contextComment,
            removeComment: contextComment !== undefined ? true : undefined,
            callback: {
                postId: event.post.id,
                comment: json2md([
                    { p: "Hi, thanks for your submission." },
                    { p: `The post tracking ${markdownEscape(user.username)} can be found [here]({{permalink}}).` },
                    { p: "Accounts submitted are reviewed **manually** by our team if not automatically classified. Please take care to only submit accounts that you suspect with a reasonable degree of confidence." },
                    { p: `Your post has been removed, and can be deleted. Consider reporting the account for Spam->Bots, as this may result in the account being suspended or shadowbanned.` },
                ]),
            },
            immediate: true,
            evaluatorsChecked: false,
        };

        const result = await queuePostCreation([submission]);
        submissionResult = result[0] ?? PostCreationQueueResult.Error;
    } catch {
        submissionResult = PostCreationQueueResult.Error;
    }

    const submissionResponse: json2md.DataObject[] = [];

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

    await postSubmissionResponse({
        submissionResponse,
        postId: event.post.id as T3,
    });
}
