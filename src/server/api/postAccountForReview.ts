import { Context } from "hono";
import { AccountReviewRequest, submitAccountForReview } from "../core/controlSubCore/modmail/accountReview";

export const handlePostAccountForReview = async (c: Context): Promise<Response> => {
    const request = await c.req.json<AccountReviewRequest | AccountReviewRequest[] | undefined>();

    if (!request) {
        return c.json({ error: "Request body is required" }, 400);
    }

    let accountsForReview: AccountReviewRequest[];
    if (Array.isArray(request)) {
        accountsForReview = request;
    } else {
        accountsForReview = [request];
    }

    for (const entry of accountsForReview) {
        await submitAccountForReview(entry);
    }

    return c.json({ success: true }, 200);
};
