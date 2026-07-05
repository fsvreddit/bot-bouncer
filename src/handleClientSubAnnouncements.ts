import { JobContext, WikiPage } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import Ajv, { JSONSchemaType } from "ajv";
import { parseAllDocuments } from "yaml";

const ANNOUNCEMENT_WIKI_PAGE = "client-sub-announcements";

interface ClientSubAnnouncement {
    announcementId: string;
    subject: string;
    body: string;
}

const clientSubAnnouncementSchema: JSONSchemaType<ClientSubAnnouncement> = {
    type: "object",
    properties: {
        announcementId: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
    },
    required: ["announcementId", "subject", "body"],
    additionalProperties: false,
};

function announcementHandledKey (announcementId: string): string {
    return `announcementHandled:${announcementId}`;
}

export async function handleClientSubAnnouncements (_: unknown, context: JobContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Client Sub Announcements: handleClientSubAnnouncements should not be called for the control subreddit, check the subreddit name handling logic");
    }

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, ANNOUNCEMENT_WIKI_PAGE);
    } catch (error) {
        console.error("Failed to fetch client sub announcements wiki page:", error);
    }

    if (!wikiPage) {
        return;
    }

    const announcements: ClientSubAnnouncement[] = [];
    const documents = parseAllDocuments(wikiPage.content);

    const ajv = new Ajv.default();

    for (const doc of documents) {
        const data = doc.toJSON() as ClientSubAnnouncement;
        const validate = ajv.compile(clientSubAnnouncementSchema);
        if (validate(data)) {
            announcements.push(data);
        } else {
            console.error("Invalid client sub announcement:", validate.errors);
        }
    }

    for (const announcement of announcements) {
        if (await context.redis.get(announcementHandledKey(announcement.announcementId))) {
            continue;
        }

        // Send the announcemnt
        try {
            await context.reddit.modMail.createModInboxConversation({
                subject: announcement.subject,
                bodyMarkdown: announcement.body,
                subredditId: context.subredditId,
            });

            await context.redis.set(announcementHandledKey(announcement.announcementId), "true");
        } catch (error) {
            console.error("Failed to send client sub announcement:", error);
        }
    }
}
