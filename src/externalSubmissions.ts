import { JobContext, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, PostFlairTemplate } from "./constants.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { getControlSubSettings } from "./settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { addMinutes, addSeconds } from "date-fns";
import { getPostOrCommentById, getUserOrUndefined } from "./utility.js";
import { isLinkId } from "@devvit/shared-types/tid.js";

const WIKI_PAGE = "externalsubmissions";

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
}

const JOB_BLOCK_REDIS_KEY = "externalSubmissionJobBlock";

export async function createExternalSubmissionJob (context: TriggerContext) {
    const isBlocked = await context.redis.get(JOB_BLOCK_REDIS_KEY);
    if (isBlocked) {
        await context.redis.del(JOB_BLOCK_REDIS_KEY);
        return;
    }

    const jobs = await context.scheduler.listJobs();
    if (jobs.some(job => job.name === EXTERNAL_SUBMISSION_JOB)) {
        return;
    }

    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        runAt: new Date(),
    });
}

export async function processExternalSubmissions (_: unknown, context: JobContext) {
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

    let stopLooping = false;
    let item: ExternalSubmission | undefined;

    // Iterate through list, and find the first user who isn't already being tracked.
    while (!stopLooping) {
        item = currentSubmissionList.shift();
        if (item) {
            const currentStatus = await getUserStatus(item.username, context);
            if (!currentStatus) {
                const user = await getUserOrUndefined(item.username, context);
                if (user) {
                    stopLooping = true;
                }
            }
        } else {
            stopLooping = true;
        }
    }

    // Resave.
    const wikiUpdateOptions = {
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify(currentSubmissionList),
    };

    await context.redis.set(JOB_BLOCK_REDIS_KEY, "true", { expiration: addMinutes(new Date(), 5) });

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

    if (!controlSubSettings.evaluationDisabled) {
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

    if (currentSubmissionList.length === 0) {
        return;
    }

    // Schedule a new ad-hoc instance.
    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        runAt: addSeconds(new Date(), 20),
    });
}
