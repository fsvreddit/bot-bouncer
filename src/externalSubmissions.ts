import { JobContext, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, EXTERNAL_SUBMISSION_JOB_CRON, PostFlairTemplate } from "./constants.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { getControlSubSettings } from "./settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { addMinutes, addSeconds } from "date-fns";
import { getPostOrCommentById, getUserOrUndefined } from "./utility.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { parseExpression } from "cron-parser";

const WIKI_PAGE = "externalsubmissions";
const EXTERNAL_SUBMISSION_QUEUE = "externalSubmissionQueue";

interface ExternalSubmission {
    username: string;
    submitter?: string;
    reportContext?: string;
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
            targetId: { type: "string", nullable: true },
            initialStatus: { type: "string", nullable: true, enum: Object.values(UserStatus) },
        },
        required: ["username"],
    },
};

export async function addExternalSubmission (data: ExternalSubmission, context: TriggerContext) {
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

    const wikiUpdateOptions = {
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify(currentUserList),
    };

    if (wikiPage) {
        await context.reddit.updateWikiPage(wikiUpdateOptions);
    } else {
        await context.reddit.createWikiPage(wikiUpdateOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName: CONTROL_SUBREDDIT,
            page: WIKI_PAGE,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
            listed: true,
        });
    }

    await scheduleAdhocExternalSubmissionsJob(context);
}

async function scheduleAdhocExternalSubmissionsJob (context: TriggerContext) {
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

    const itemsInQueue = await context.redis.hLen(EXTERNAL_SUBMISSION_QUEUE);
    if (itemsInQueue === 0) {
        console.log("External Submissions: No remaining items in the queue.");
        return;
    }

    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        runAt: addSeconds(new Date(), 20),
    });

    console.log("External Submissions: Ad-hoc job scheduled.");
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

        const itemInQueue = await context.redis.hGet(EXTERNAL_SUBMISSION_QUEUE, item.username);
        if (itemInQueue) {
            console.log(`External Submissions: ${item.username} is already in the queue.`);
            continue;
        }

        await context.redis.hSet(EXTERNAL_SUBMISSION_QUEUE, { [item.username]: JSON.stringify(item) });
        console.log(`External Submissions: Added ${item.username} to the queue.`);
    }

    // Resave.
    const wikiUpdateOptions = {
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify([]),
    };

    if (wikiPage) {
        await context.reddit.updateWikiPage(wikiUpdateOptions);
    } else {
        await context.reddit.createWikiPage(wikiUpdateOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName: CONTROL_SUBREDDIT,
            page: WIKI_PAGE,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
            listed: true,
        });
    }

    await scheduleAdhocExternalSubmissionsJob(context);
}

export async function processExternalSubmissions (_: unknown, context: JobContext) {
    const submissionQueue = await context.redis.hGetAll(EXTERNAL_SUBMISSION_QUEUE);
    const usersInQueue = Object.keys(submissionQueue);
    if (usersInQueue.length === 0) {
        console.log("External Submissions: Queue is empty.");
        return;
    }

    let stopLooping = false;
    let username: string | undefined;
    let item: ExternalSubmission | undefined;
    // Iterate through list, and find the first user who isn't already being tracked.
    while (!stopLooping) {
        username = usersInQueue.shift();
        if (username) {
            const currentStatus = await getUserStatus(username, context);
            if (!currentStatus) {
                const user = await getUserOrUndefined(username, context);
                if (user) {
                    stopLooping = true;
                    item = JSON.parse(submissionQueue[username]) as ExternalSubmission;
                }
            }
            await context.redis.hDel(EXTERNAL_SUBMISSION_QUEUE, [username]);
        } else {
            stopLooping = true;
        }
    }

    if (!item) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    const newStatus = ((item.submitter && controlSubSettings.trustedSubmitters.includes(item.submitter)) || item.initialStatus === UserStatus.Banned) ? UserStatus.Banned : UserStatus.Pending;
    const newFlair = newStatus === UserStatus.Banned ? PostFlairTemplate.Banned : PostFlairTemplate.Pending;

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${item.username}`,
        url: `https://www.reddit.com/user/${item.username}`,
        flairId: newFlair,
    });

    if (item.reportContext) {
        let text = "The submitter added the following context for this submission:\n\n";
        text += item.reportContext.split("\n").map(line => `> ${line}`).join("\n");
        if (item.targetId) {
            const target = await getPostOrCommentById(item.targetId, context);
            text += `\n\nUser was reported via [this ${isLinkId(target.id) ? "post" : "comment"}](${target.permalink})`;
        }
        text += `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*`;
        await newPost.addComment({ text });
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

    await setUserStatus(item.username, {
        userStatus: newStatus,
        lastUpdate: new Date().getTime(),
        submitter: item.submitter,
        operator: context.appName,
        trackingPostId: newPost.id,
    }, context);

    console.log(`External submission created for ${item.username}`);

    await scheduleAdhocExternalSubmissionsJob(context);
}
