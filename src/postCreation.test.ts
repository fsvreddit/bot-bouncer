import { UserStatus } from "./dataStore.js";
import { statusToFlair } from "./postCreation.js";

test("Every user status has a corresponding post flair template", () => {
    const statusNames = Object.values(UserStatus);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const missingStatuses = statusNames.filter(status => statusToFlair[status] === undefined);
    expect(missingStatuses).toEqual([]);
});
