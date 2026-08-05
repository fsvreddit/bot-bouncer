import type { UserSocialLink } from "@devvit/public-api";
import {
    getHackedProfileRecoveryReviewDelayDays,
    getStoredProfileFields,
    socialLinksReverted,
} from "./hackedProfileRecoveryReview.js";

function socialLink (outboundUrl: string): UserSocialLink {
    return { outboundUrl } as UserSocialLink;
}

test("recovery reviews use the configured increasing delays", () => {
    expect([
        getHackedProfileRecoveryReviewDelayDays(0),
        getHackedProfileRecoveryReviewDelayDays(1),
        getHackedProfileRecoveryReviewDelayDays(2),
        getHackedProfileRecoveryReviewDelayDays(3),
        getHackedProfileRecoveryReviewDelayDays(4),
    ]).toEqual([
        7,
        14,
        30,
        60,
        undefined,
    ]);
});

test("stored profile fields ignore empty values", () => {
    expect(getStoredProfileFields({
        bioText: " ",
        displayName: undefined,
        socialLinks: [],
    })).toEqual([]);

    expect(getStoredProfileFields({
        bioText: "Promotional bio",
        displayName: "Profile name",
        socialLinks: [socialLink("https://example.com/profile")],
    })).toEqual([
        "bio",
        "display name",
        "social links",
    ]);
});

test("social links count as reverted only when all original links are absent", () => {
    const originalLinks = [
        socialLink("https://example.com/first/"),
        socialLink("https://example.com/second"),
    ];

    expect(socialLinksReverted(originalLinks, [
        socialLink("https://example.com/SECOND/"),
    ])).toBe(false);

    expect(socialLinksReverted(originalLinks, [
        socialLink("https://example.com/replacement"),
    ])).toBe(true);
});

test("no original social links cannot count as a reverted field", () => {
    expect(socialLinksReverted([], [])).toBe(false);
});
