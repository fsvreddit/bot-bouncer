import { redis, TaskRequest, TaskResponse } from "@devvit/web/server";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { ConfigWikiPage, validateControlSubConfigChange } from "../core";
import { addMinutes } from "date-fns";
import { validateAndSaveAppealConfig } from "../core/controlSubCore/modmail";
import { Context } from "hono";

export type HandleConfigWikiChangeRequestData = {
    page: ConfigWikiPage;
    updatedBy: string;
    jobGuid?: string;
};

export const handleConfigWikiChangeJob = async (c: Context): Promise<Response> => {
    const event = await c.req.json<TaskRequest<HandleConfigWikiChangeRequestData>>();

    const configWikiPage = event.data.page;
    const updatedBy = event.data.updatedBy;
    const redisKey = `configWikiQueued:${configWikiPage}`;

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`handleConfigWikiChange: Job with guid ${jobGuid} has already been handled, skipping.`);
        return c.json<TaskResponse>({ message: "Job has already been handled, skipping." }, 200);
    }

    switch (configWikiPage) {
        case ConfigWikiPage.AutoAppealHandling:
            await validateAndSaveAppealConfig(updatedBy);
            break;
        case ConfigWikiPage.ControlSubSettings:
            await validateControlSubConfigChange(updatedBy);
            break;
        default:
            console.error(`handleConfigWikiChange: Unknown config wiki page: ${configWikiPage}`);
    }

    await redis.del(redisKey);

    return c.json<TaskResponse>({ message: "Config wiki change handled successfully" }, 200);
};
