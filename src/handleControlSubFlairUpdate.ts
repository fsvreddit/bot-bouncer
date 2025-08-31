import { TriggerContext } from "@devvit/public-api";
import { PostFlairUpdate } from "@devvit/protos";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { getUserStatus, setUserStatus, UserDetails, UserFlag, UserStatus, writeUserStatus } from "./dataStore.js";
import { getUsernameFromUrl } from "./utility.js";
import { queueSendFeedback } from "./submissionFeedback.js";
import { uniq } from "lodash";
import { addHours } from "date-fns";
import { addToReversalsQueue } from "./evaluatorReversals.js";

interface FlairMapping {
    postFlair: string;
    flagToSet: UserFlag;
    destinationFlair: PostFlairTemplate;
    removeFromDatabaseAfterDays?: number;
}

export const FLAIR_MAPPINGS: FlairMapping[] = [
    {
        postFlair: "recovered",
        flagToSet: UserFlag.HackedAndRecovered,
        destinationFlair: PostFlairTemplate.Organic,
    },
    {
        postFlair: "scammed",
        flagToSet: UserFlag.Scammed,
        destinationFlair: PostFlairTemplate.Organic,
    },
    {
        postFlair: "locked",
        flagToSet: UserFlag.Locked,
        destinationFlair: PostFlairTemplate.Banned,
    },
];

export async function handleControlSubFlairUpdate (event: PostFlairUpdate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.author?.name || !event.post) {
        return;
    }

    const appUser = await context.reddit.getAppUser();

    if (event.post.authorId !== appUser.id) {
        return;
    }

    const postFlair = event.post.linkFlair?.text as UserStatus | undefined;
    if (!postFlair) {
        return;
    }

    const ignoreCheck = await context.redis.exists(`ignoreflairchange:${event.post.id}`);
    if (ignoreCheck) {
        return;
    }

    const username = getUsernameFromUrl(event.post.url);
    if (!username) {
        return;
    }

    // Handle post flair mappings here.
    const mapping = FLAIR_MAPPINGS.find(m => m.postFlair === postFlair as string);
    if (mapping) {
        const currentStatus = await getUserStatus(username, context);
        if (currentStatus) {
            const flags = currentStatus.flags ?? [];
            flags.push(mapping.flagToSet);
            currentStatus.flags = uniq(flags);
            await writeUserStatus(username, currentStatus, context.redis);
        }

        if (event.author.name !== context.appName) {
            await context.redis.set(`userStatusOverride~${username}`, event.author.name, { expiration: addHours(new Date(), 1) });
        }

        await context.reddit.setPostFlair({
            postId: event.post.id,
            subredditName: CONTROL_SUBREDDIT,
            flairTemplateId: mapping.destinationFlair,
        });

        if (mapping.removeFromDatabaseAfterDays) {
            await addToReversalsQueue(username, mapping.removeFromDatabaseAfterDays, context);
        }

        console.log(`Flair Update: Mapped flair ${postFlair} to flag ${mapping.flagToSet} for user ${username}.`);

        return;
    }

    if (!Object.values(UserStatus).includes(postFlair)) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);

    let operator = event.author.name;
    const overrideOperator = await context.redis.get(`userStatusOverride~${username}`);
    if (overrideOperator) {
        operator = overrideOperator;
        await context.redis.del(`userStatusOverride~${username}`);
    }

    let newStatus: UserDetails;
    if (currentStatus) {
        newStatus = { ...currentStatus };
        newStatus.trackingPostId = event.post.id;
        newStatus.userStatus = postFlair;
        newStatus.operator = operator;
        newStatus.lastUpdate = new Date().getTime();
    } else {
        newStatus = {
            trackingPostId: event.post.id,
            userStatus: postFlair,
            lastUpdate: new Date().getTime(),
            operator,
        };
    }

    await setUserStatus(username, newStatus, context);

    console.log(`Flair Update: Status for ${username} set to ${postFlair} by ${operator}`);

    const post = await context.reddit.getPostById(event.post.id);

    // Look for Account Properties comment and delete it.
    if (postFlair !== UserStatus.Pending) {
        const comment = await post.comments.all();
        const commentToDelete = comment.find(c => c.authorName === context.appName && c.body.startsWith("## Account Properties"));

        if (commentToDelete) {
            await commentToDelete.delete();
        }

        if (post.numberOfReports > 0) {
            await context.reddit.approve(event.post.id);
        }
    }

    if (currentStatus?.userStatus === UserStatus.Pending && currentStatus.submitter && postFlair !== UserStatus.Pending) {
        await queueSendFeedback(username, context);
    }
}
