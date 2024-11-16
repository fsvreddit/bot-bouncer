import { JobContext, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, PostFlairTemplate } from "./constants.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";

const WIKI_PAGE = "externalsubmissions";

export async function addExternalSubmission (username: string, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        //
    }

    const currentUserList = JSON.parse(wikiPage?.content ?? "[]") as string[];

    if (currentUserList.includes(username)) {
        return;
    }

    currentUserList.push(username);

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

    const currentUserList = JSON.parse(wikiPage?.content ?? "[]") as string[];
    if (currentUserList.length === 0) {
        return;
    }

    let canContinue = false;
    let username: string | undefined;
    while (!canContinue) {
        username = currentUserList.shift();
        if (username) {
            const currentStatus = await getUserStatus(username, context);
            if (!currentStatus) {
                canContinue = true;
            }
        } else {
            canContinue = true;
        }
    }

    // Resave.
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

    if (!username) {
        return;
    }

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${username}`,
        url: `https://www.reddit.com/user/${username}`,
        flairId: PostFlairTemplate.Pending,
    });

    await context.scheduler.runJob({
        name: EVALUATE_USER,
        runAt: new Date(),
        data: {
            username,
            postId: newPost.id,
            run: 1,
        },
    });

    await setUserStatus(username, {
        userStatus: UserStatus.Pending,
        lastUpdate: new Date().getTime(),
        operator: context.appName,
        trackingPostId: newPost.id,
    }, context);

    console.log(`External submission created for ${username}`);

    if (currentUserList.length === 0) {
        return;
    }

    // Schedule a new ad-hoc instance.
    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        runAt: new Date(),
    });
}
