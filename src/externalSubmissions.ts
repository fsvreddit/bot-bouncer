import { JobContext, TriggerContext, User, WikiPage } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, EXTERNAL_SUBMISSION_JOB_CRON } from "./constants.js";
import { getUserStatus, setUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { getControlSubSettings } from "./settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { getPostOrCommentById, getUserOrUndefined } from "./utility.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { parseExpression } from "cron-parser";
import { createNewSubmission } from "./postCreation.js";
import pluralize from "pluralize";

const WIKI_PAGE = "externalsubmissions";
export const EXTERNAL_SUBMISSION_QUEUE = "externalSubmissionQueue";

export interface ExternalSubmission {
    username: string;
    submitter?: string;
    reportContext?: string;
    publicContext?: boolean;
    targetId?: string;
    initialStatus?: UserStatus;
};

const schema: JSONSchemaType<ExternalSubmission[]> = {
    type: "array",
    items: {
        type: "object",
        properties: {
            username: { type: "string" },
            submitter: { type: "string", nullable: true },
            reportContext: { type: "string", nullable: true },
            publicContext: { type: "boolean", nullable: true },
            targetId: { type: "string", nullable: true },
            initialStatus: { type: "string", nullable: true, enum: Object.values(UserStatus) },
        },
        required: ["username"],
    },
};

function getExternalSubmissionDataKey (username: string) {
    return `externalSubmission:${username}`;
}

export async function addExternalSubmission (data: ExternalSubmission, submissionType: "automatic" | "manual", context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const redisKey = `externalSubmission:${data.username}`;
    const alreadyDone = await context.redis.get(redisKey);
    if (alreadyDone) {
        return;
    }

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addMinutes(new Date(), 5) });

    // Set local status
    await setUserStatus(data.username, {
        userStatus: UserStatus.Pending,
        lastUpdate: new Date().getTime(),
        submitter: data.submitter,
        operator: context.appName,
        trackingPostId: "",
    }, context);

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        //
    }

    const currentUserList = JSON.parse(wikiPage?.content ?? "[]") as ExternalSubmission[];

    const ajv = new Ajv.default();
    const validate = ajv.compile(schema);
    if (!validate(currentUserList)) {
        console.error("External submission list is invalid.", ajv.errorsText(validate.errors));
        return;
    }

    if (currentUserList.some(item => item.username === data.username)) {
        return;
    }

    currentUserList.push(data);

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify(currentUserList),
        reason: `Added a user via ${context.subredditName ? `/r/${context.subredditName}` : "an unknown subreddit"}. Type: ${submissionType}`,
    });

    await scheduleAdhocExternalSubmissionsJob(context);
}

export async function scheduleAdhocExternalSubmissionsJob (context: TriggerContext, delay = 20) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const cron = parseExpression(EXTERNAL_SUBMISSION_JOB_CRON);
    const nextRun = cron.next().toDate();

    if (nextRun < addMinutes(new Date(), 1)) {
        console.log("External Submissions: Next scheduled run is too soon.");
        return;
    }

    const currentJobs = await context.scheduler.listJobs();
    const externalSubmissionJobs = currentJobs.filter(job => job.name === EXTERNAL_SUBMISSION_JOB);
    if (externalSubmissionJobs.length > 1) {
        console.log("External Submissions: Multiple jobs already scheduled.");
        return;
    }

    const itemsInQueue = await context.redis.zCard(EXTERNAL_SUBMISSION_QUEUE);
    if (itemsInQueue === 0) {
        console.log("External Submissions: No remaining items in the queue.");
        return;
    }

    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        runAt: addSeconds(new Date(), delay),
    });

    console.log(`External Submissions: Ad-hoc job scheduled, ${itemsInQueue} ${pluralize("user", itemsInQueue)} remain in queue.`);
}

export async function handleExternalSubmissionsPageUpdate (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        //
    }

    const currentSubmissionList = JSON.parse(wikiPage?.content ?? "[]") as ExternalSubmission[];

    const ajv = new Ajv.default();
    const validate = ajv.compile(schema);
    if (!validate(currentSubmissionList)) {
        console.error("External submission list is invalid.", ajv.errorsText(validate.errors));
        return;
    }

    if (currentSubmissionList.length === 0) {
        return;
    }

    for (const item of currentSubmissionList) {
        const currentStatus = await getUserStatus(item.username, context);
        if (currentStatus) {
            console.log(`External Submissions: Status for ${item.username} already exists.`);
            continue;
        }

        const itemInQueue = await context.redis.zScore(EXTERNAL_SUBMISSION_QUEUE, item.username);
        if (itemInQueue) {
            console.log(`External Submissions: ${item.username} is already in the queue.`);
            continue;
        }

        await context.redis.set(getExternalSubmissionDataKey(item.username), JSON.stringify(item), { expiration: addDays(new Date(), 28) });
        await context.redis.zAdd(EXTERNAL_SUBMISSION_QUEUE, { member: item.username, score: new Date().getTime() });
        console.log(`External Submissions: Added ${item.username} to the queue.`);
    }

    // Resave.
    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify([]),
        reason: "Cleared the external submission list",
    });

    await scheduleAdhocExternalSubmissionsJob(context, 0);
}

export async function processExternalSubmissions (_: unknown, context: JobContext) {
    const submissionQueue = await context.redis.zRange(EXTERNAL_SUBMISSION_QUEUE, 0, -1);
    const usersInQueue = Object.keys(submissionQueue);
    if (usersInQueue.length === 0) {
        console.log("External Submissions: Queue is empty.");
        return;
    }

    let stopLooping = false;
    let username: string | undefined;
    let item: ExternalSubmission | undefined;
    let user: User | undefined;
    // Iterate through list, and find the first user who isn't already being tracked.
    while (!stopLooping) {
        username = usersInQueue.shift();
        if (username) {
            user = await getUserOrUndefined(username, context);
            if (user) {
                const currentStatus = await getUserStatus(user.username, context);
                if (!currentStatus) {
                    const submissionData = await context.redis.get(getExternalSubmissionDataKey(username));
                    if (!submissionData) {
                        console.log(`External Submissions: ${username} is not in the database, skipping.`);
                        await context.redis.zRem(EXTERNAL_SUBMISSION_QUEUE, [username]);
                        continue;
                    }
                    stopLooping = true;
                    item = JSON.parse(submissionData) as ExternalSubmission;
                    item.username = user.username;
                } else {
                    console.log(`External Submissions: ${username} is already being tracked, skipping.`);
                }
            } else {
                console.log(`External Submissions: ${username} is deleted or shadowbanned, skipping.`);
            }

            await context.redis.zRem(EXTERNAL_SUBMISSION_QUEUE, [username]);
            await context.redis.del(getExternalSubmissionDataKey(username));
        } else {
            stopLooping = true;
        }
    }

    if (!item || !user) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);

    let newStatus: UserStatus;
    if (item.initialStatus) {
        newStatus = item.initialStatus;
    } else {
        newStatus = item.submitter && controlSubSettings.trustedSubmitters.includes(item.submitter) ? UserStatus.Banned : UserStatus.Pending;
    }

    const newUserDetails: UserDetails = {
        userStatus: newStatus,
        lastUpdate: new Date().getTime(),
        submitter: item.submitter,
        operator: context.appName,
        trackingPostId: "",
    };

    const newPost = await createNewSubmission(user, newUserDetails, context);

    if (item.reportContext) {
        let text = "The submitter added the following context for this submission:\n\n";
        text += item.reportContext.split("\n").map(line => `> ${line}`).join("\n");
        if (item.targetId) {
            const target = await getPostOrCommentById(item.targetId, context);
            text += `\n\nUser was reported via [this ${isLinkId(target.id) ? "post" : "comment"}](${target.permalink})`;
        }
        text += `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*`;
        const newComment = await newPost.addComment({ text });

        if (item.publicContext === false) {
            await newComment.remove();
        }
    }

    if (!controlSubSettings.evaluationDisabled && newStatus === UserStatus.Pending) {
        await context.scheduler.runJob({
            name: EVALUATE_USER,
            runAt: addSeconds(new Date(), 10),
            data: {
                username: item.username,
                postId: newPost.id,
            },
        });
    }

    console.log(`External submission created for ${item.username}`);

    await scheduleAdhocExternalSubmissionsJob(context);
}
