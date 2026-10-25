import type { Context } from "hono";
import { context, reddit, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT, getUsernameFromUrl, handleControlSubPostCreate } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { subMinutes } from "date-fns";
import { CrowdControlLevel, DistinguishType, OnPostCreateRequest } from "@devvit/web/shared";

export type UnprocessedSubmissionsJobData = {
    jobGuid: string;
};

export const handleUnprocessedSubmissionsJobJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<UnprocessedSubmissionsJobData>>();

    if (await hasEventBeenHandled(`job:${jobRequest.data.jobGuid}`)) {
        return c.json<TaskResponse>({ message: "Event has already been handled" }, 200);
    }

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Job should only run on the control subreddit");
    }

    const modQueue = await reddit.getModQueue({
        subreddit: CONTROL_SUBREDDIT,
        type: "post",
        limit: 1000,
    }).all().then(posts => posts.filter(post => post.authorName !== context.appSlug && post.createdAt < subMinutes(new Date(), 10) && getUsernameFromUrl(post.url)));

    const firstUnprocessedSubmission = modQueue.shift();
    if (!firstUnprocessedSubmission) {
        return c.json<TaskResponse>({ message: "No unprocessed submissions found" }, 200);
    }

    const event: OnPostCreateRequest = {
        type: "PostCreate",
        author: {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            accountType: 1,
            banned: false,
            description: "",
            iconImage: "",
            id: "t2_0",
            isGold: false,
            karma: 0,
            name: firstUnprocessedSubmission.authorName,
            snoovatarImage: "",
            spam: false,
            suspended: false,
            url: "",
        },
        subreddit: {
            name: CONTROL_SUBREDDIT,
            description: "",
            id: "t5_0",
            nsfw: false,
            permalink: `/r/${CONTROL_SUBREDDIT}/`,
            quarantined: false,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            rating: 1,
            spam: false,
            subscribersCount: 0,
            title: "",
            topics: [],
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            type: 5,
        },
        post: {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            authorId: firstUnprocessedSubmission.authorId!,
            id: firstUnprocessedSubmission.id,
            createdAt: firstUnprocessedSubmission.createdAt.getTime(),
            url: firstUnprocessedSubmission.url,
            title: firstUnprocessedSubmission.title,
            crosspostParentId: "",
            crowdControlLevel: CrowdControlLevel.OFF,
            deleted: false,
            distinguished: DistinguishType.NULL_VALUE,
            downvotes: 0,
            upvotes: 0,
            galleryImages: [],
            gildings: 0,
            ignoreReports: false,
            isApproved: false,
            isArchived: false,
            isLocked: false,
            isClubContent: false,
            isGallery: false,
            isImage: false,
            isMeta: false,
            isMultiMedia: false,
            isPoll: false,
            isSelf: false,
            isVideo: false,
            isSpoiler: false,
            isPromoted: false,
            isSticky: false,
            languageCode: "EN",
            mediaUrls: [],
            nsfw: false,
            numComments: 0,
            numReports: 0,
            permalink: firstUnprocessedSubmission.permalink,
            score: 0,
            selftext: "",
            spam: false,
            subredditId: "t5_0",
            thumbnail: "",
            type: "",
            unlisted: false,
            updatedAt: Date.now(),
        },
    };

    await handleControlSubPostCreate(event);

    return c.json<TaskResponse>({ success: true }, 200);
};
