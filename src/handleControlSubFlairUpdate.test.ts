import { UserStatus } from "./dataStore.js";
import { FLAIR_MAPPINGS } from "./handleControlSubFlairUpdate.js";

test("Post Flair Mappings don't clash with user statuses", () => {
    const flairMappings = FLAIR_MAPPINGS.map(m => m.postFlair);
    const userStatusValues = Object.values(UserStatus) as string[];
    const clashes = flairMappings.filter(flair => userStatusValues.includes(flair));
    expect(clashes).toEqual([]);
});

test("Post flair mappings have positive value for removal", () => {
    const badMappings = FLAIR_MAPPINGS.filter(m => m.removeFromDatabaseAfterDays !== undefined && m.removeFromDatabaseAfterDays <= 0);
    expect(badMappings).toHaveLength(0);
});
