import { JobContext, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, PostFlairTemplate } from "./constants.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { getControlSubSettings } from "./settings.js";
import Ajv, { JSONSchemaType } from "ajv";

const WIKI_PAGE = "externalsubmissions";

interface ExternalSubmission {
    username: string;
    submitter?: string;
    reportContext?: string;
};

const schema: JSONSchemaType<ExternalSubmission[]> = {
    type: "array",
    items: {
        type: "object",
        properties: {
            username: { type: "string" },
            submitter: { type: "string", nullable: true },
            reportContext: { type: "string", nullable: true },
        },
        required: ["username"],
    },
};

export async function addExternalSubmission (username: string, submitter: string | undefined, reportContext: string | undefined, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

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

    if (currentUserList.some(item => item.username === username)) {
        return;
    }

    currentUserList.push({ username, submitter, reportContext });

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

export async function createExternalSubmissionJob (context: TriggerContext) {
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
                stopLooping = true;
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
    const newStatus = item.submitter && controlSubSettings.trustedSubmitters.includes(item.submitter) ? UserStatus.Banned : UserStatus.Pending;
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
        text += `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*`;
        await newPost.addComment({ text });
    }

    if (!controlSubSettings.evaluationDisabled) {
        await context.scheduler.runJob({
            name: EVALUATE_USER,
            runAt: new Date(),
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
        runAt: new Date(),
    });
}
