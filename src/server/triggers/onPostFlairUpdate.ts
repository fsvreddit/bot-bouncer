import type { Context } from "hono";
import { context, reddit, redis } from "@devvit/web/server";
import { OnPostFlairUpdateRequest, T3, TriggerResponse } from "@devvit/web/shared";
import { CONTROL_SUBREDDIT, FLAIR_MAPPINGS, getPostFlairUpdateIgnoreKey, getUsernameFromUrl, getUserStatus, queueSendFeedback, setUserStatus, statusToFlair, UserDetails, writeUserStatus } from "../core";
import { fixPostTriggerEvent, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { addHours, addMinutes, addSeconds } from "date-fns";
import { addToReversalsQueue, submitAccountForReview } from "../core/controlSubCore/modmail";
import { uniq } from "lodash-es";

export const onPostFlairUpdate = async (c: Context): Promise<Response> => {
    let request = await c.req.json<OnPostFlairUpdateRequest>();

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return c.json<TriggerResponse>({ message: "Wrong subreddit" }, 200);
    }

    request = await fixPostTriggerEvent(request);

    if (!request.author?.name || !request.post) {
        return c.json({ message: "Invalid request" }, 200);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
    const postFlair = request.post.linkFlair?.text as UserStatus | undefined;
    if (!postFlair) {
        return c.json<TriggerResponse>({ message: "No post flair" }, 200);
    }

    if (await redis.exists(getPostFlairUpdateIgnoreKey(request.post.id))) {
        return c.json<TriggerResponse>({ message: "Ignored flair change for post" }, 200);
    }

    if (await hasEventBeenHandled(`PostFlairUpdate:${request.post.id}:${postFlair}`, { expiration: addSeconds(new Date(), 10) })) {
        return c.json<TriggerResponse>({ message: "Trigger already handled" }, 200);
    }

    const appUser = await reddit.getAppUser();
    if (!appUser) {
        return c.json<TriggerResponse>({ message: "App user not found" }, 200);
    }

    if (request.post.authorId !== appUser.id) {
        return c.json<TriggerResponse>({ message: "Post author is not the app user" }, 200);
    }

    const username = getUsernameFromUrl(request.post.url);
    if (!username) {
        return c.json<TriggerResponse>({ message: "Username not found in post URL" }, 200);
    }

    await redis.set(`postFlairUpdateLock~${username}`, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    // Handle post flair mappings here.
    const mapping = FLAIR_MAPPINGS.find(m => m.postFlair === postFlair as string);
    if (mapping) {
        const currentStatus = await getUserStatus(username);
        if (currentStatus) {
            const flags = currentStatus.flags ?? [];
            flags.push(mapping.flagToSet);
            currentStatus.flags = uniq(flags);
            await writeUserStatus(username, currentStatus);
        }

        if (request.author.name !== context.appSlug) {
            await redis.set(`userStatusOverrideValue~${username}`, request.author.name, { expiration: addHours(new Date(), 1) });
        }

        await reddit.setPostFlair({
            postId: request.post.id as T3,
            subredditName: CONTROL_SUBREDDIT,
            flairTemplateId: mapping.destinationFlair,
        });

        if (mapping.removeFromDatabaseAfterDays && mapping.removeFromDatabaseAfterDays > 0) {
            await addToReversalsQueue(username, mapping.removeFromDatabaseAfterDays);
        }

        console.log(`Flair Update: Mapped flair ${postFlair} to flag ${mapping.flagToSet} for user ${username}, new status ${mapping.destinationFlair}.`);

        return c.json<TriggerResponse>({ message: "Flair mapped successfully" }, 200);
    }

    // Handle flairs with review periods specified
    const regex = `^(${Object.values(UserStatus).join("|")}):(\\d+)$`;
    const match = new RegExp(regex).exec(postFlair);
    if (request.author.name !== context.appSlug && match) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
        const status = match[1] as UserStatus;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const reviewPeriod = parseInt(match[2]!, 10);
        await redis.set(`userStatusOverrideValue~${username}`, request.author.name, { expiration: addHours(new Date(), 1) });

        await reddit.setPostFlair({
            postId: request.post.id as T3,
            subredditName: CONTROL_SUBREDDIT,
            flairTemplateId: statusToFlair[status],
        });

        await submitAccountForReview({
            postId: request.post.id as T3,
            duration: reviewPeriod,
            reviewRequestedBy: request.author.name,
        });

        return c.json<TriggerResponse>({ message: "Flair update with review period processed" }, 200);
    }

    if (!Object.values(UserStatus).includes(postFlair)) {
        return c.json<TriggerResponse>({ message: `Invalid flair on ${request.post.id}` }, 200);
    }

    const currentStatus = await getUserStatus(username);

    let operator = request.author.name;
    const overrideOperator = await redis.get(`userStatusOverrideValue~${username}`);
    if (overrideOperator) {
        operator = overrideOperator;
        await redis.del(`userStatusOverrideValue~${username}`);
    }

    let newStatus: UserDetails;
    if (currentStatus) {
        newStatus = { ...currentStatus };
        newStatus.trackingPostId = request.post.id as T3;
        newStatus.userStatus = postFlair;
        newStatus.operator = operator;
        newStatus.lastUpdate = new Date().getTime();
    } else {
        newStatus = {
            trackingPostId: request.post.id as T3,
            userStatus: postFlair,
            lastUpdate: new Date().getTime(),
            operator,
        };
    }

    await setUserStatus(username, newStatus);

    console.log(`Flair Update: Status for ${username} set to ${newStatus.userStatus} by ${operator}`);

    const post = await reddit.getPostById(request.post.id as T3);

    // Look for Account Properties/OpenAI Summary comment and delete it.
    if (postFlair !== UserStatus.Pending) {
        const comment = await post.comments.all();
        const commentToDelete = comment.filter(c => c.authorName === context.appSlug && (c.body.includes("## Account Properties") || c.body.trim().startsWith("**OpenAI Summary**")));

        if (commentToDelete.length > 0) {
            for (const c of commentToDelete) {
                await c.delete();
            }
        }

        if (post.numberOfReports > 0) {
            await reddit.approve(request.post.id as T3);
        }
    }

    if (currentStatus?.userStatus === UserStatus.Pending && currentStatus.submitter && postFlair !== UserStatus.Pending) {
        await queueSendFeedback(username);
    }

    return c.json<TriggerResponse>({ message: "Flair update processed" });
};
