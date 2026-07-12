import { describe, expect, it } from "vitest";
import {
    AIHistoryItem,
    buildEvaluatorChangeDigest,
    buildHistoryCoverage,
    buildProfileChanges,
    buildPromotionDigest,
    buildReuseDigest,
} from "./evidenceDigests.js";

function post (overrides: Partial<Extract<AIHistoryItem, { type: "post" }>> = {}): Extract<AIHistoryItem, { type: "post" }> {
    return {
        id: "t3_example",
        type: "post",
        title: "Example title",
        content: "Example body",
        karma: 1,
        subredditName: "example",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        ...overrides,
    };
}

function comment (overrides: Partial<Extract<AIHistoryItem, { type: "comment" }>> = {}): Extract<AIHistoryItem, { type: "comment" }> {
    return {
        id: "t1_example",
        type: "comment",
        content: "Example comment",
        karma: 1,
        subredditName: "example",
        createdAt: new Date("2026-07-02T00:00:00Z"),
        postId: "t3_parent",
        parentId: "t3_parent",
        isTopLevel: true,
        ...overrides,
    };
}

describe("AI evidence digests", () => {
    it("reports history coverage and retrieval limitations", () => {
        const coverage = buildHistoryCoverage([
            post(),
            comment(),
        ], 2, 1);

        expect(coverage).toMatchObject({
            totalItemsRetrieved: 2,
            postsRetrieved: 1,
            commentsRetrieved: 1,
            combinedLimitReached: true,
            failedParentPostLookups: 1,
        });
        expect(coverage.oldestItemAt).toEqual(new Date("2026-07-01T00:00:00Z"));
        expect(coverage.newestItemAt).toEqual(new Date("2026-07-02T00:00:00Z"));
    });

    it("emits only changed profile fields", () => {
        const changes = buildProfileChanges({
            bio: "Old bio",
            displayName: "Same name",
            socialLinkUrls: ["https://old.example/profile"],
        }, {
            bio: "New bio",
            displayName: "Same name",
            socialLinkUrls: ["https://new.example/profile"],
        });

        expect(changes).toEqual({
            bio: { original: "Old bio", current: "New bio" },
            socialLinks: {
                added: ["https://new.example/profile"],
                removed: ["https://old.example/profile"],
            },
        });
    });

    it("summarizes repeated destinations, handles, and referral parameters", () => {
        const digest = buildPromotionDigest({
            bio: "Find me on Telegram: example_handle",
            socialLinkUrls: ["https://shop.example/item?ref=abc"],
        }, [
            comment({ content: "Telegram: example_handle https://shop.example/item?ref=abc" }),
        ]);

        expect(digest?.domains?.[0]).toMatchObject({
            domain: "shop.example",
            occurrences: 2,
        });
        expect(digest?.contactHandles?.[0]).toMatchObject({
            value: "example_handle",
            occurrences: 2,
        });
        expect(digest?.referralIndicators).toEqual([{ parameter: "ref", occurrences: 2 }]);
    });

    it("clusters exact repeated titles and comments", () => {
        const digest = buildReuseDigest([
            post({ id: "t3_one", title: "A distinctive repeated title", subredditName: "one" }),
            post({ id: "t3_two", title: "  A DISTINCTIVE repeated title  ", subredditName: "two", createdAt: new Date("2026-07-03T00:00:00Z") }),
            comment({ id: "t1_one", content: "A sufficiently long repeated comment" }),
            comment({ id: "t1_two", content: "A sufficiently long repeated comment", subredditName: "two", createdAt: new Date("2026-07-04T00:00:00Z") }),
        ]);

        expect(digest?.exactTitleClusters?.[0]).toMatchObject({
            occurrences: 2,
            subredditCount: 2,
        });
        expect(digest?.exactCommentClusters?.[0]).toMatchObject({
            occurrences: 2,
            subredditCount: 2,
        });
    });

    it("distinguishes persistent, resolved, and new evaluator matches", () => {
        const digest = buildEvaluatorChangeDigest([
            { botName: "Persistent", canAutoBan: true, metThreshold: true },
            { botName: "Resolved", canAutoBan: true, metThreshold: true, hitReason: "matched regex: very long regex" },
        ], [
            { botName: "Persistent", canAutoBan: true, metThreshold: true },
            { botName: "New", canAutoBan: false, metThreshold: true },
        ], {
            Persistent: "Persistent description",
        });

        expect(digest.persistentEvaluatorNames).toEqual(["Persistent"]);
        expect(digest.resolvedEvaluatorNames).toEqual(["Resolved"]);
        expect(digest.newlyMatchedEvaluatorNames).toEqual(["New"]);
        expect(digest.initial[1].reason).toContain("[omitted; available in deterministic summary]");
    });
});
