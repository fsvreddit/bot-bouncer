import { context } from "@devvit/web/server";
import { MenuItemRequest, UiResponse } from "@devvit/web/shared";
import type { Context } from "hono";
import { CONTROL_SUBREDDIT } from "../core";
import { handleControlSubredditMenu } from "./controlSubMenu";
import { handleClientSubredditMenu } from "./clientSubMenu";

export const handlePostAndCommentMenu = async (c: Context): Promise<Response> => {
    const request = await c.req.json<MenuItemRequest>();

    if (context.subredditName === CONTROL_SUBREDDIT) {
        return c.json<UiResponse>(await handleControlSubredditMenu(request));
    } else {
        return c.json<UiResponse>(await handleClientSubredditMenu(request));
    }
};
