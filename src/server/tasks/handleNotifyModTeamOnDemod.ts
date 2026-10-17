import { context, reddit, redis, TaskRequest, TaskResponse } from "@devvit/web/server";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addMinutes } from "date-fns";
import { Context } from "hono";
import { getControlSubSettings } from "../core";

export type NotifyModTeamOnDemodRequestData = {
    modName?: string;
    jobGuid?: string;
};

export const handleNotifyModTeamOnDemodJob = async (c: Context): Promise<Response> => {
    const event = await c.req.json<TaskRequest<NotifyModTeamOnDemodRequestData>>();

    const notificationDoneKey = "demodNotificationSent";
    const alreadyNotified = await redis.exists(notificationDoneKey);
    if (alreadyNotified) {
        console.log("notifyModTeamOnDemod: Notification already sent, skipping.");
        return c.json<TaskResponse>({ message: "Notification already sent, skipping." }, 200);
    }

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`notifyModTeamOnDemod: Job with guid ${jobGuid} has already been handled, skipping.`);
        return c.json<TaskResponse>({ message: "Job has already been handled, skipping." }, 200);
    }

    const subredditName = context.subredditName;

    const moderators = await reddit.getModerators({
        subredditName,
        username: context.appSlug,
    }).all();

    if (moderators.length > 0) {
        console.log(`notifyModTeamOnDemod: Still a moderator of r/${subredditName}, no notification sent.`);
        return c.json<TaskResponse>({ message: "Still a moderator, no notification sent." }, 200);
    }

    const modName = event.data.modName ?? "A moderator";
    const controlSubSettings = await getControlSubSettings();

    let message = controlSubSettings.appRemovedMessage;
    if (!message) {
        console.log(`notifyModTeamOnDemod: No app removed message configured for r/${subredditName}, no notification sent.`);
        return c.json<TaskResponse>({ message: "No app removed message configured, no notification sent." }, 200);
    }

    message = message.replaceAll("{modName}", modName);
    message = message.replaceAll("{subredditName}", subredditName);

    message += "\n\n*This message was sent automatically, replies will not be read.*";

    await reddit.sendPrivateMessage({
        to: `/r/${subredditName}`,
        subject: "Bot Bouncer has been removed as a moderator",
        text: message,
    });

    console.log(`notifyModTeamOnDemod: Notified r/${subredditName} mod team of Bot Bouncer removal.`);
    await redis.set(notificationDoneKey, "true");

    return c.json<TaskResponse>({ message: "Notification sent successfully." }, 200);
};
