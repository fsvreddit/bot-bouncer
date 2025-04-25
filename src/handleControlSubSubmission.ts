import { TriggerContext } from "@devvit/public-api";
import { PostCreate } from "@devvit/protos";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { getUsernameFromUrl, isModerator } from "./utility.js";
import { getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { subMonths } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import { createNewSubmission } from "./postCreation.js";
import { getUserExtended, UserExtended } from "./extendedDevvit.js";
import json2md from "json2md";

export async function handleControlSubSubmission (event: PostCreate, context: TriggerContext) {
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

        submissionResponse.push(
            { p: "Hi, thanks for your submission" },
            { p: "Only links to user accounts are permitted here." },
        );
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.reporterBlacklist.includes(event.author.name)) {
        submissionResponse.push({ p: "You are not currently permitted to submit bots to r/BotBouncer. Please write in to modmail if you believe this is a mistake" });
    }

    const submitterStatus = await getUserStatus(event.author.name, context);
    if (submitterStatus && submitterStatus.userStatus === UserStatus.Banned) {
        submissionResponse.push({ p: "You are currently listed as a bot on r/BotBouncer, so we cannot accept submissions from you. Please write in to modmail if you believe this is a mistake" });
    }

    let user: UserExtended | undefined;
    if (username) {
        user = await getUserExtended(username, context);
    }

    if (!user && submissionResponse.length === 0) {
        submissionResponse.push(
            { p: "Hi, thanks for your submission" },
            { p: `${username} appears to be deleted, suspended or shadowbanned already, so no post will be created for it.` },
        );
    }

    if (user?.username === event.author.name) {
        submissionResponse.push(
            { p: "Hi, thanks for your submission" },
            { p: "You cannot make a submission for yourself." },
        );
    }

    if (user) {
        const userContent = await context.reddit.getCommentsAndPostsByUser({
            username: user.username,
            limit: 100,
            sort: "new",
        }).all();

        if (userContent.filter(item => item.createdAt > subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3)).length === 0) {
            submissionResponse.push(
                { p: "Hi, thanks for your submission" },
                { p: `${username} has no recent content on their history, so may be retired. Submissions can only be made for active users.` },
            );
        }
    }

    if (user && submissionResponse.length === 0) {
        const currentStatus = await getUserStatus(user.username, context);
        if (currentStatus) {
            const post = await context.reddit.getPostById(currentStatus.trackingPostId);
            submissionResponse.push(
                { p: "Hi, thanks for your submission" },
                { p: `${username} is already tracked by Bot Bouncer with a current status of ${currentStatus.userStatus}, you can see the submission [here](${post.permalink}).` },
            );

            if (currentStatus.userStatus === UserStatus.Organic) {
                submissionResponse.push({ p: `If you have information about how this user is a bot that we may have missed, please [modmail us](https://www.reddit.com/message/compose?to=/r/BotBouncer&subject=More%20information%20about%20/u/${user.username}) with the details, so that we can review again.` });
            }
        } else {
            const newStatus = controlSubSettings.trustedSubmitters.includes(event.author.name) ? UserStatus.Banned : UserStatus.Pending;

            const newDetails: UserDetails = {
                userStatus: newStatus,
                lastUpdate: new Date().getTime(),
                submitter: event.author.name,
                operator: context.appName,
                trackingPostId: "",
            };

            const newPost = await createNewSubmission(user, newDetails, context);

            console.log(`Created new post for ${username}`);

            submissionResponse.push(
                { p: "Hi, thanks for your submission" },
                { p: `The post tracking ${user.username} can be found [here](${newPost.permalink}).` },
                { p: `Your post has been removed, and can be deleted.` },
            );

            await context.scheduler.runJob({
                name: ControlSubredditJob.EvaluateUser,
                runAt: new Date(),
                data: {
                    username: user.username,
                    postId: newPost.id,
                },
            });
        }
    }

    if (submissionResponse.length > 0) {
        const newComment = await context.reddit.submitComment({
            id: event.post.id,
            text: json2md(submissionResponse),
        });
        await newComment.distinguish(true);
    }

    await context.reddit.remove(event.post.id, false);
}
