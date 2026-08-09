import { UserStatus } from "./types.js";
import { FLAIR_MAPPINGS } from "./handleControlSubFlairUpdate.js";
import { expect, test } from "vitest";

test("Post Flair Mappings don't clash with user statuses", () => {
    const flairMappings = FLAIR_MAPPINGS.map(m => m.postFlair);
    const userStatusValues = Object.values(UserStatus) as string[];
    const clashes = flairMappings.filter(flair => userStatusValues.includes(flair));
    expect(clashes).toEqual([]);
});
