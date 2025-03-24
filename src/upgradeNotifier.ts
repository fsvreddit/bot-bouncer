import { JobContext, WikiPage } from "@devvit/public-api";
import { AppSetting } from "./settings.js";
import { lt } from "semver";

interface AppUpdate {
    appname: string;
    version: string;
    whatsNewBullets: string[];
}

const UPDATE_SUBREDDIT = "fsvapps";
const UPDATE_WIKI_PAGE = "upgrade-notifier";

export async function checkForUpdates (_: unknown, context: JobContext) {
    const notificationsEnabled = await context.settings.get<boolean>(AppSetting.UpgradeNotifier);
    if (!notificationsEnabled) {
        console.log("Update Checker: Notifications are disabled");
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(UPDATE_SUBREDDIT, UPDATE_WIKI_PAGE);
    } catch {
        console.error(`Update Checker: Error getting wiki page ${UPDATE_WIKI_PAGE} from ${UPDATE_SUBREDDIT}`);
        return;
    }

    const updates = JSON.parse(wikiPage.content) as AppUpdate[];
    const updatesForThisApp = updates.filter(update => update.appname === context.appName);
    if (updatesForThisApp.length === 0) {
        console.log(`Update Checker: No updates found for app ${context.appName}`);
        return;
    }

    if (updatesForThisApp.length > 1) {
        console.error(`Update Checker: Multiple updates found for app ${context.appName}`);
        return;
    }

    if (!lt(context.appVersion, updatesForThisApp[0].version)) {
        console.log("Update Checker: No updates found");
        return;
    }

    const update = updatesForThisApp[0];
    const redisKey = "update-notification-sent";
    const notificationSent = await context.redis.get(redisKey);
    if (notificationSent === update.version) {
        return;
    }

    let message = "A new version of Bot Bouncer is available to install.\n\n";
    if (update.whatsNewBullets.length > 0) {
        message += "Here's what's new:\n\n";
        message += update.whatsNewBullets.map(bullet => `* ${bullet}`).join("\n");
    }

    message += `\n\nTo install this update, or to disable these notifications, visit the [Bot Bouncer Configuration Page](https://developers.reddit.com/r/${subredditName}/apps/${context.appName}) for /r/${subredditName}.`;

    await context.reddit.modMail.createModNotification({
        subredditId: context.subredditId,
        subject: `New Bot Bouncer Update Available: v${update.version}`,
        bodyMarkdown: message,
    });

    console.log(`Update Checker: Notification sent for version ${update.version}`);

    await context.redis.set(redisKey, update.version);
}
